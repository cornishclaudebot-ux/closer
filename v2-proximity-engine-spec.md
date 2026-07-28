# Hot Spots V2, Proximity Engine + Next.js Spec

The technical backing for the [vision page](closer-v2-vision.html). Schema lives in
[`supabase/migrations/0001_closer_v2.sql`](supabase/migrations/0001_closer_v2.sql).

## The one hard problem
"Match when you actually cross paths" = detect that two students were **within ~50 m of
each other within ~5 min**, count how often, and surface the people you keep crossing.
Everything else (likes, chat) is standard. This is the part worth getting right.

## How detection works
1. **Ingest.** The phone posts a location ping every ~60 s while on campus into
   `location_pings` (a `geography(Point,4326)`).
2. **Match in space + time.** On each ping, `closer_detect_encounters()` runs a
   spatiotemporal join: `ST_DWithin(geog, :ping, 50)` (uses the GIST index, meters) against
   other users' pings from the last 5 minutes.
3. **Collapse into sessions.** An `encounters` row is upserted per unordered pair. Standing
   next to someone for 20 min is ONE encounter; the count only ticks up when there's a
   **>30 min gap** since you last crossed. That's how "3rd time this week" stays honest.
4. **Label it (internal only).** `closer_nearest_place()` tags the encounter with the nearest
   campus POI from `campus_places`. This stays server-side and is NEVER shown to users.

Three knobs, all in the SQL: **radius 50 m · window 5 min · new-session gap 30 min.**

**Two layers.** This PostGIS engine is the *coarse* layer (GPS + geofence: "you were at the
same place"). Raw GPS tops out around 16 ft, so the *fine* ~20 ft "crossed within arm's reach"
signal is **Bluetooth LE / UWB**, added in V2. V1 ships on the coarse layer plus venue/event
check-in.

**MVP vs scale:** an `AFTER INSERT` trigger fires detection per ping (simple, instant, fine
for hundreds of students). At scale, drop the trigger and run the same function over new
pings from a **pg_cron batch every 1 to 2 min** so the write path stays fast.

## Privacy model (non-negotiable for a location app)
- Raw traces are **ephemeral**: a pg_cron job deletes pings older than **2 h**. Encounters
  (the value) persist; the breadcrumb trail does not.
- **Nobody reads anyone's raw location.** `location_pings` RLS is `user_id = auth.uid()`.
  Detection runs `SECURITY DEFINER`, so the cross-user math happens server-side and only the
  derived encounter (that you crossed, plus time and distance) is ever exposed.
- **Never name the place.** The feed shows *time + distance* only ("came within their space,
  2:14 PM, ~20 ft"). `last_place` is computed server-side for internal use and is never
  returned to a client, so no one's location history is exposed.
- **On-campus only.** The client geofences to GCU before it reports at all.
- Block/report tables, and an `is_discoverable` kill switch, are first-class.
- Photos sit in a **private Storage bucket**; RLS gates every table.

## Next.js app (App Router on Vercel)
```
app/
  (auth)/login/page.tsx          # GCU Microsoft (Entra) sign-in
  (app)/paths/page.tsx           # server component -> rpc('get_crossed_paths')
  (app)/hearts/page.tsx          # blurred incoming hearts, tap to reveal (realtime)
  (app)/chat/[personId]/page.tsx # messages, unlocked by crossing paths (keyed to the encounter)
  (app)/profile/page.tsx        # edit profile, photos, discoverable toggle
  api/ping/route.ts             # POST a location ping (throttled, geofenced)
lib/supabase/
  server.ts   client.ts         # @supabase/ssr clients
hooks/
  useProximityReporter.ts       # sends pings on campus every 60s
  useLiveMatches.ts             # subscribes to matches inserts
```

**Auth / the GCU gate.** Supabase Auth with the **Microsoft Entra (Azure AD) provider**:
students sign in with their GCU Microsoft account. Verify the gcu.edu / student subdomain
server-side and set `gcu_verified`. Does not require GCU IT cooperation.

**Report a ping**, `app/api/ping/route.ts`:
```ts
export async function POST(req: Request) {
  const { lat, lng, accuracy } = await req.json();
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { error } = await supabase.from("location_pings").insert({
    user_id: user.id,
    geog: `SRID=4326;POINT(${lng} ${lat})`, // PostGIS WKT; note lng THEN lat
    accuracy_m: accuracy,
  });
  return new Response(null, { status: error ? 400 : 204 });
}
```

**Client reporter**, `hooks/useProximityReporter.ts` (sketch): `watchPosition`, throttle to
60 s, skip if outside the campus bounding box, `POST /api/ping`. Pause when `is_discoverable`
is off or the tab is hidden.

**Paths feed** (your persistent Match Portfolio), server component, one call, RLS-safe:
```ts
const { data: crossings } = await supabase.rpc("get_crossed_paths");
// -> [{ other_id, display_name, age, photos, encounter_count, last_at, min_distance_m }]
// note: NO place field. Time + distance only, by design.
```

**Live match**, `hooks/useLiveMatches.ts`:
```ts
supabase.channel("matches")
  .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "matches", filter: `user_a=eq.${uid}` },
      ({ new: m }) => showMatch(m))
  .subscribe();
```

**"You're both here now"**, Supabase Realtime *presence* on a `campus-presence` channel;
each client `track({ area })`, and the chat header lights up when a match's key is present in
the same area. No table needed.

## Env
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...        # server only, never shipped to client
```

## Build order (maps to the vision's 5 steps)
1. **Waitlist → Supabase.** Repoint the current form at `signups`. *(ready now)*
2. **Auth + profiles.** GCU Microsoft (Entra) sign-in, profile + photo upload, discoverable toggle.
3. **Proximity engine.** Run this migration, ship `useProximityReporter` + the Discover feed. Seed `campus_places` with GCU POIs.
4. **Realtime match + chat.** Likes → match trigger, messages, presence.
5. **Launch on Vercel.** Custom domain, edge, and the n8n signup/safety/digest workflows.

## Open decisions (yours to call later)
- **Radius/window.** 50 m / 5 min is a starting point; tune after real campus data.
- **Ping cadence vs battery.** 60 s is a balance; could back off when stationary.
- **Trigger vs pg_cron.** Start with the trigger, switch to batch when concurrency climbs.
- **Photos moderation.** Manual at first, or an n8n review step on upload.
