// Netlify Scheduled Function: send-reminders
// Runs every minute. Checks for holidays/exam-day overrides first; otherwise
// finds anyone whose next class starts in ~10 minutes and sends a push.

import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import type { Config } from '@netlify/functions';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY!;

webpush.setVapidDetails(
  'mailto:admin@slotifytts.netlify.app',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const REMINDER_LEAD_MINUTES = 10;
const DAY_MAP = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// One-time holiday/exam messages (e.g. "Happy Ganesh Chaturthi!") won't be
// sent before this hour (24-hour, IST) — so people don't get woken up by
// a festival greeting at midnight. It'll just wait and check again each
// minute until this hour arrives, then send once as normal.
const EARLIEST_MESSAGE_HOUR = 8;

// Period start times (minutes after midnight, IST) for each row layout.
// 'standard' = periods 1-9 with lunch as period 5 (CSE, AIML, CSBS, IT, ECE ...).
// 'mech'     = periods 1-8 (Mechanical).
// These must match ROW_TEMPLATES in index.html.
const PERIOD_STARTS: Record<string, Record<number, number>> = {
  standard: { 1: 540, 2: 590, 3: 650, 4: 700, 6: 800, 7: 850, 8: 910, 9: 960 },
  mech:     { 1: 540, 2: 590, 3: 650, 4: 700, 5: 800, 6: 850, 7: 910, 8: 960 },
};

// Year-scoped department ids look like "mech@y3" — the base id is "mech".
function templateFor(deptId: string, saved: Record<string, string>): string {
  const t = saved[deptId];
  if (t && PERIOD_STARTS[t]) return t;
  return deptId.split('@')[0] === 'mech' ? 'mech' : 'standard';
}

// Get current time in IST regardless of the server's own timezone (Netlify runs in UTC).
function getISTNow(): Date {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const istOffsetMs = 5.5 * 60 * 60000;
  return new Date(utcMs + istOffsetMs);
}

function toDateString(d: Date): string {
  // YYYY-MM-DD, matching Postgres 'date' column format
  return d.toISOString().slice(0, 10);
}

async function sendToAllSubscribers(title: string, body: string) {
  const { data: subs, error } = await supabase.from('push_subscriptions').select('*');
  if (error || !subs) return 0;

  let sent = 0;
  for (const sub of subs) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(pushSubscription, JSON.stringify({ title, body }), {
        urgency: 'normal', // a greeting isn't as time-critical as a "starts in 10 min" reminder
        TTL: 43200,        // 12 hours — survives a phone being off overnight, unlike the 5-min class-reminder TTL
      });
      sent++;
    } catch (err: any) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      } else {
        console.error('Push failed (broadcast):', err);
      }
    }
  }
  return sent;
}

export default async () => {
  try {
    const istNow = getISTNow();
    const todayStr = toDateString(istNow);

    // --- Check for a holiday/exam override on today's date first ---
    const { data: override, error: overrideError } = await supabase
      .from('calendar_overrides')
      .select('*')
      .eq('date', todayStr)
      .maybeSingle();

    if (overrideError) throw overrideError;

    if (override) {
      // Send the one-time message once, the first run of the day it applies,
      // but not before EARLIEST_MESSAGE_HOUR.
      if (override.one_time_message && !override.message_sent && istNow.getUTCHours() >= EARLIEST_MESSAGE_HOUR) {
        const sent = await sendToAllSubscribers('Slotify', override.one_time_message);
        await supabase
          .from('calendar_overrides')
          .update({ message_sent: true })
          .eq('id', override.id);
        return new Response(
          JSON.stringify({ ok: true, oneTimeMessageSent: sent, suppressedReminders: !!override.suppress_reminders }),
          { status: 200 }
        );
      }

      if (override.suppress_reminders) {
        // Holiday/exam day — skip normal class reminders entirely.
        return new Response(
          JSON.stringify({ ok: true, sent: 0, reason: `reminders suppressed (${override.type})` }),
          { status: 200 }
        );
      }
      // If suppress_reminders is false, fall through to normal logic below.
    }

    // --- Normal class-reminder logic ---
    const dayName = DAY_MAP[istNow.getUTCDay()];
    const nowMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
    const targetMinutes = nowMinutes + REMINDER_LEAD_MINUTES;

    // Skip the database entirely when no period of any layout starts in 10 minutes.
    const anyPeriod = Object.values(PERIOD_STARTS).some(m => Object.values(m).includes(targetMinutes));
    if (!anyPeriod) {
      return new Response(JSON.stringify({ ok: true, sent: 0, reason: 'no period starting in 10 min' }), { status: 200 });
    }

    // Saved row layouts for custom / per-year departments
    const { data: deptRows } = await supabase.from('departments').select('id, row_template');
    const savedTemplates: Record<string, string> = {};
    for (const d of deptRows ?? []) if (d.row_template) savedTemplates[d.id] = d.row_template;

    const { data: timetables, error: ttError } = await supabase
      .from('timetables')
      .select('dept_id, section, grid');

    if (ttError) throw ttError;

    const matches: { dept_id: string; section: string; label: string }[] = [];

    for (const row of timetables ?? []) {
      const dayGrid = row.grid?.[dayName];
      if (!dayGrid) continue;

      const starts = PERIOD_STARTS[templateFor(row.dept_id, savedTemplates)];
      const matchingPeriods = Object.entries(starts)
        .filter(([, startMin]) => startMin === targetMinutes)
        .map(([period]) => Number(period));
      if (matchingPeriods.length === 0) continue;

      for (const slot of dayGrid) {
        const [startPeriod, , label] = slot;
        if (matchingPeriods.includes(startPeriod)) {
          // use the full subject name if the admin added one for this timetable
          const full = row.grid?._legend?.[label]?.name;
          matches.push({ dept_id: row.dept_id, section: row.section, label: full || label });
        }
      }
    }

    if (matches.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0, reason: 'no classes found for matching period' }), { status: 200 });
    }

    let sent = 0;

    for (const match of matches) {
      const { data: subs, error: subError } = await supabase
        .from('push_subscriptions')
        .select('*')
        .eq('dept_id', match.dept_id)
        .eq('section', match.section);

      if (subError || !subs) continue;

      for (const sub of subs) {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        };

        try {
          await webpush.sendNotification(
            pushSubscription,
            JSON.stringify({
              title: 'Class starting soon',
              body: `${match.label} starts in ${REMINDER_LEAD_MINUTES} minutes`,
            }),
            {
              urgency: 'high', // this is the time-sensitive one — must wake the device now
              TTL: 1200,       // 20 min — gives some slack for brief connectivity gaps
            }
          );
          sent++;
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          } else {
            console.error('Push failed:', err);
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, sent, matchedClasses: matches.length }), { status: 200 });
  } catch (err: any) {
    console.error('send-reminders error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
};

export const config: Config = {
  schedule: '*/1 * * * *',
};
