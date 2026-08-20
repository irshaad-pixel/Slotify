// Netlify Scheduled Function: send-reminders
// Runs every minute, finds anyone whose next class starts in ~10 minutes, and
// sends them a real push notification via the Web Push protocol.

import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';
import type { Config } from '@netlify/functions';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY!;

webpush.setVapidDetails(
  'mailto:admin@slotifytt.netlify.app',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const REMINDER_LEAD_MINUTES = 10;
const DAY_MAP = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Real period start times (24-hour, IST). Period number -> minutes after midnight.
const PERIOD_START_MINUTES: Record<number, number> = {
  1: 9 * 60,        // 9:00 AM
  2: 9 * 60 + 50,    // 9:50 AM
  3: 10 * 60 + 50,   // 10:50 AM
  4: 11 * 60 + 40,   // 11:40 AM
  5: 13 * 60 + 20,   // 1:20 PM
  6: 14 * 60 + 10,   // 2:10 PM
  7: 15 * 60 + 10,   // 3:10 PM
  8: 16 * 60,        // 4:00 PM
};

// Get current time in IST regardless of the server's own timezone (Netlify runs in UTC).
function getISTNow(): Date {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const istOffsetMs = 5.5 * 60 * 60000;
  return new Date(utcMs + istOffsetMs);
}

export default async () => {
  try {
    const istNow = getISTNow();
    const dayName = DAY_MAP[istNow.getDay()];
    const nowMinutes = istNow.getHours() * 60 + istNow.getMinutes();
    const targetMinutes = nowMinutes + REMINDER_LEAD_MINUTES;

    // Find which period (if any) starts within this minute's target window.
    const matchingPeriods = Object.entries(PERIOD_START_MINUTES)
      .filter(([, startMin]) => startMin === targetMinutes)
      .map(([period]) => Number(period));

    if (matchingPeriods.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0, reason: 'no period starting in 10 min' }), { status: 200 });
    }

    const { data: timetables, error: ttError } = await supabase
      .from('timetables')
      .select('dept_id, section, grid');

    if (ttError) throw ttError;

    const matches: { dept_id: string; section: string; label: string }[] = [];

    for (const row of timetables ?? []) {
      const dayGrid = row.grid?.[dayName];
      if (!dayGrid) continue;

      for (const slot of dayGrid) {
        // slot format: [startPeriod, endPeriod, "LABEL", optional room string]
        const [startPeriod, , label] = slot;
        if (matchingPeriods.includes(startPeriod)) {
          matches.push({ dept_id: row.dept_id, section: row.section, label });
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
            })
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
