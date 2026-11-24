// derzhimsya — morning reminder, triggered by pg_cron at 07:00 UTC (10:00 MSK).
// Asks about YESTERDAY: the day is over, so the answer is honest.
// Deploy with "Verify JWT" ENABLED — cron sends the service role key.

import { db, fetchStats } from "../_shared/api.ts";
import { type Participant, sendCheckins } from "../_shared/checkin.ts";

Deno.serve(async () => {
  const stats = await fetchStats();
  const participants = await db(
    "participants?select=id,name,gender,telegram_chat_id&order=sort_order",
  ) as Participant[];

  const asked: string[] = [];
  for (const participant of participants) {
    const dates = await sendCheckins(stats, participant, true);
    asked.push(...dates.map((date) => `${participant.id}@${date}`));
  }

  return Response.json({ today: stats.today, asked });
});
