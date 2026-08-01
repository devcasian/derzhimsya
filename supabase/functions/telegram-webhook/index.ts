// derzhimsya — Telegram webhook.
// Deploy with "Verify JWT" DISABLED: Telegram cannot send a Supabase JWT.
// Authenticity is enforced by the secret token header instead.

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
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

interface Participant {
  id: string;
  name: string;
  telegram_chat_id: number;
}

interface Habit {
  id: string;
  participant_id: string;
  title: string;
  is_shared: boolean;
}

interface Stats {
  habits: Array<{ id: string; title: string; isShared: boolean; currentStreak: number }>;
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

async function findParticipant(chatId: number): Promise<Participant | null> {
  const rows = await db(
    `participants?telegram_chat_id=eq.${chatId}&select=id,name,telegram_chat_id`,
  ) as Participant[];
  return rows[0] ?? null;
}

async function findHabit(habitId: string): Promise<Habit | null> {
  const rows = await db(
    `habits?id=eq.${encodeURIComponent(habitId)}&select=id,participant_id,title,is_shared`,
  ) as Habit[];
  return rows[0] ?? null;
}

async function handleCallback(query: {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_id: number };
  from: { id: number };
}): Promise<void> {
  const chatId = query.message?.chat.id ?? query.from.id;
  const participant = await findParticipant(chatId);

  if (!participant || !query.data?.startsWith("c:")) {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Не узнаю тебя" });
    return;
  }

  const [, habitId, date, flag] = query.data.split(":");
  const habit = await findHabit(habitId);

  // Guards against a button forwarded to the wrong chat.
  if (!habit || habit.participant_id !== participant.id) {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Это не твоя привычка" });
    return;
  }

  const success = flag === "1";

  await db("checkins?on_conflict=habit_id,date", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ habit_id: habit.id, date, success }),
  });

  const stats = await db("rpc/stats", { method: "POST", body: "{}" }) as Stats;
  const state = stats.habits.find((h) => h.id === habit.id)!;

  const verdict = success ? "✅ продержался" : "❌ сорвался";
  const pairLine = habit.is_shared ? `\nВместе: ${days(stats.pair.currentStreak)}` : "";
  const text = `${habit.title} — ${formatDate(date)}\n${verdict}\n\n` +
    `Твой стрик: ${days(state.currentStreak)}${pairLine}\n\n` +
    SITE_URL;

  await telegram("answerCallbackQuery", { callback_query_id: query.id });
  if (query.message) {
    await telegram("editMessageText", {
      chat_id: chatId,
      message_id: query.message.message_id,
      text,
    });
  }

  // Personal habits stay personal — only shared ones are worth nudging the
  // other person about.
  if (!habit.is_shared) return;

  const others = await db(
    `participants?id=neq.${participant.id}&select=id,name,telegram_chat_id`,
  ) as Participant[];

  for (const other of others) {
    await telegram("sendMessage", {
      chat_id: other.telegram_chat_id,
      text: `${participant.name} отметил ${formatDate(date)}: ${verdict}\n` +
        `Вместе: ${days(stats.pair.currentStreak)}`,
    });
  }
}

async function handleMessage(message: {
  chat: { id: number };
  text?: string;
}): Promise<void> {
  const chatId = message.chat.id;
  const participant = await findParticipant(chatId);

  if (!participant) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `Этот бот приватный.\nТвой chat_id: ${chatId}`,
    });
    return;
  }

  // The bot has no commands: it asks, you press a button. Everything else
  // lives on the site.
  await telegram("sendMessage", {
    chat_id: chatId,
    text: `Привет, ${participant.name}.\n\n` +
      `Каждое утро в 10:00 я спрошу про вчерашний день — отвечаешь одной кнопкой.\n\n` +
      `Вся статистика на сайте:\n${SITE_URL}`,
  });
}

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  // Always answer 200 — a non-2xx makes Telegram retry the same update forever.
  try {
    const update = await req.json();
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) await handleMessage(update.message);
  } catch (error) {
    console.error("update failed:", error);
  }

  return new Response("ok");
});
