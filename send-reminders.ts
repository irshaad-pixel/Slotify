// Supabase Edge Function: send-reminders
// Deploy this as a scheduled function (see deployment instructions).
// Runs every minute, finds anyone whose next class starts in ~10 minutes, and
// sends them a real push notification via the Web Push protocol.

import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;

webpush.setVapidDetails("mailto:admin@slotifytts.netlify.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const REMINDER_LEAD_MINUTES = 10;
const DAY_MAP = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Mirrors the client-side ROW_TEMPLATES — must stay in sync with index.html if the
// period structure ever changes there.
const ROW_TEMPLATES: Record<string, { n: number; start: string }[]> = {
  standard: [
    { n: 1, start: "09:00" }, { n: 2, start: "09:50" },
    { n: 3, start: "10:50" }, { n: 4, start: "11:40" },
    { n: 6, start: "13:20" }, { n: 7, start: "14:10" },
    { n: 8, start: "15:10" }, { n: 9, start: "16:00" },
  ],
  mech: [
    { n: 1, start: "09:00" }, { n: 2, start: "09:50" },
    { n: 3, start: "10:50" }, { n: 4, start: "11:40" },
    { n: 5, start: "13:20" }, { n: 6, start: "14:10" },
    { n: 7, start: "15:10" }, { n: 8, start: "16:00" },
  ],
};

function timeToMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

async function sb(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${path} (${res.status})`);
  return res.json();
}

Deno.serve(async () => {
  try {
    // Server runs in UTC — convert to IST (UTC+5:30) for real class-time comparisons.
    const nowUtc = new Date();
    const nowIst = new Date(nowUtc.getTime() + 5.5 * 60 * 60 * 1000);
    const nowMin = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
    const dayIdx = nowIst.getUTCDay();
    const todayShort = DAY_MAP[dayIdx];

    if (todayShort === "Sat" || todayShort === "Sun") {
      return new Response(JSON.stringify({ sent: 0, note: "weekend, no classes" }), { status: 200 });
    }

    const [subs, departments] = await Promise.all([
      sb("push_subscriptions?select=*"),
      sb("departments?select=id,row_template"),
    ]);

    const rowTemplateByDept: Record<string, string> = {};
    for (const d of departments) rowTemplateByDept[d.id] = d.row_template || "standard";

    // Group subscriptions by dept+section so we only fetch each timetable once
    const groups: Record<string, any[]> = {};
    for (const s of subs) {
      const key = `${s.dept_id}::${s.section}`;
      (groups[key] ||= []).push(s);
    }

    let sent = 0;
    let removed = 0;

    for (const key of Object.keys(groups)) {
      const [deptId, section] = key.split("::");
      const rows = await sb(
        `timetables?dept_id=eq.${encodeURIComponent(deptId)}&section=eq.${encodeURIComponent(section)}&select=grid`
      );
      if (!rows.length) continue;
      const grid = rows[0].grid;
      const todayBlocks: any[] = grid[todayShort] || [];
      if (!todayBlocks.length) continue;

      const periods = ROW_TEMPLATES[rowTemplateByDept[deptId] || "standard"];
      const periodStart: Record<number, number> = {};
      periods.forEach((p) => { periodStart[p.n] = timeToMinutes(p.start); });

      // Find any class starting in exactly [lead-0.5, lead+0.5) minutes from now,
      // matching this function's ~1-minute run cadence so each class only fires once.
      const dueBlock = todayBlocks.find((b) => {
        const startMin = periodStart[b[0]];
        if (startMin == null) return false;
        const minutesUntil = startMin - nowMin;
        return minutesUntil === REMINDER_LEAD_MINUTES;
      });
      if (!dueBlock) continue;

      const code = dueBlock[2];
      const body = `${code} starts in ${REMINDER_LEAD_MINUTES} minutes`;
      const payload = JSON.stringify({ title: "Slotify", body });

      for (const sub of groups[key]) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          );
          sent++;
        } catch (err: any) {
          // 404/410 means the subscription is dead (browser data cleared, uninstalled, etc) — clean it up
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${sub.id}`, {
              method: "DELETE",
              headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
            });
            removed++;
          }
        }
      }
    }

    return new Response(JSON.stringify({ sent, removed }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
