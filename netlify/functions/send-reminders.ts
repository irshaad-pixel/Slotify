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

const REMINDER_LEAD_MINUTES = 10;
const DAY_MAP = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

export default async () => {
  try {
    const now = new Date();
    const target = new Date(now.getTime() + REMINDER_LEAD_MINUTES * 60000);
    const dayName = DAY_MAP[target.getDay()];
    const targetHour = target.getHours();
    const targetMinute = target.getMinutes();

    // Fetch all timetables
    const { data: timetables, error: ttError } = await supabase
      .from('timetables')
      .select('dept_id, section, grid');

    if (ttError) throw ttError;

    const matches: { dept_id: string; section: string; label: string }[] = [];

    for (const row of timetables ?? []) {
      const dayGrid = row.grid?.[dayName];
      if (!dayGrid) continue;

      for (const slot of dayGrid) {
        // slot format: [startHour, endHour, "LABEL", optional room string]
        const [startHour, , label] = slot;
        if (startHour === targetHour || (startHour === targetHour + 1 && targetMinute >= 50)) {
          matches.push({ dept_id: row.dept_id, section: row.section, label });
        }
      }
    }

    if (matches.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200 });
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
            // Subscription expired/invalid — clean it up
            await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          } else {
            console.error('Push failed:', err);
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, sent }), { status: 200 });
  } catch (err: any) {
    console.error('send-reminders error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
};

export const config: Config = {
  schedule: '*/1 * * * *',
};
