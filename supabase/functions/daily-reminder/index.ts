// derzhimsya — morning reminder, triggered by pg_cron at 07:00 UTC (10:00 MSK).
// Asks about YESTERDAY: the day is over, so the answer is honest.
// Deploy with "Verify JWT" ENABLED — cron sends the service role key.

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SITE_URL = Deno.env.get("SITE_URL")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function formatDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${Number(day)} ${MONTHS_GENITIVE[Number(month) - 1]}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function days(n: number): string {
  return `${n} ${plural(n, "день", "дня", "дней")}`;
}

function shiftDate(isoDate: string, delta: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

interface Habit {
  id: string;
  participant_id: string;
  question: string;
  title: string;
  participants: { name: string; telegram_chat_id: number };
}

interface Stats {
  today: string;
  habits: Array<{
    id: string;
    isShared: boolean;
    currentStreak: number;
    days: Array<{ date: string; status: string }>;
  }>;
  pair: { currentStreak: number };
}

async function db(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`postgrest ${res.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

async function telegram(method: string, payload: unknown): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`telegram ${method} failed:`, await res.text());
}

Deno.serve(async () => {
  const stats = await db("rpc/stats", { method: "POST", body: "{}" }) as Stats;
  const habits = await db(
    "habits?select=id,participant_id,question,title,participants(name,telegram_chat_id)" +
    "&order=participant_id,sort_order",
  ) as Habit[];

  const yesterday = shiftDate(stats.today, -1);
  const asked: string[] = [];

  for (const habit of habits) {
    const state = stats.habits.find((h) => h.id === habit.id);
    if (!state) continue;

    // Oldest first: the bot has no commands, so every unreported day needs its
    // own message with its own buttons before it ages out of the grace window.
    const pending = state.days
      .filter((d) => d.status === "pending" && d.date !== stats.today)
      .map((d) => d.date)
      .sort();

    for (const date of pending) {
      const isYesterday = date === yesterday;
      const heading = isYesterday
        ? `Доброе утро, ${habit.participants.name}.`
        : `${habit.participants.name}, этот день остался неотмеченным.`;

      const pairLine = state.isShared
        ? `\nВместе: ${days(stats.pair.currentStreak)} подряд`
        : "";

      await telegram("sendMessage", {
        chat_id: habit.participants.telegram_chat_id,
        text: `${heading}\n\n` +
          `${habit.title} — ${formatDate(date)}\n${habit.question}\n\n` +
          `Твой стрик: ${days(state.currentStreak)}${pairLine}\n\n` +
          SITE_URL,
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Держался", callback_data: `c:${habit.id}:${date}:1` },
            { text: "❌ Сорвался", callback_data: `c:${habit.id}:${date}:0` },
          ]],
        },
      });

      asked.push(`${habit.id}@${date}`);
    }
  }

  return Response.json({ date: yesterday, asked });
});
