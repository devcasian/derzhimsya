// derzhimsya — Telegram webhook.
// Deploy with "Verify JWT" DISABLED: Telegram cannot send a Supabase JWT.
// Authenticity is enforced by the secret token header instead.

import { db, fetchStats, SITE_URL, telegram } from "../_shared/api.ts";
import {
  byGender,
  days,
  formatDate,
  isOpen,
  type Participant,
  pendingDates,
  renderCheckin,
  type Stats,
  statusOn,
  verdict,
} from "../_shared/checkin.ts";

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const ADMIN_CHAT_ID = Deno.env.get("TELEGRAM_ADMIN_CHAT_ID")!;

interface IncomingMessage {
  chat: { id: number };
  from?: { first_name: string; last_name?: string; username?: string };
  text?: string;
}

interface CallbackQuery {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_id: number; text?: string };
  from: { id: number };
}

async function findParticipant(chatId: number): Promise<Participant | null> {
  const rows = await db(
    `participants?telegram_chat_id=eq.${chatId}&select=id,name,gender,telegram_chat_id`,
  ) as Participant[];
  return rows[0] ?? null;
}

async function answer(queryId: string, text?: string): Promise<void> {
  await telegram("answerCallbackQuery", { callback_query_id: queryId, text });
}

async function refresh(
  query: CallbackQuery,
  stats: Stats,
  participant: Participant,
  date: string,
): Promise<void> {
  if (!query.message) return;
  // The heading is not rebuilt but copied from the message itself, so a
  // morning greeting stays a morning greeting after an afternoon tap.
  const heading = query.message.text?.split("\n")[0] ?? participant.name;
  await telegram("editMessageText", {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    ...renderCheckin(stats, participant, date, heading),
  });
}

async function handleCallback(query: CallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id ?? query.from.id;
  const participant = await findParticipant(chatId);

  if (!participant || !query.data?.startsWith("c:")) {
    await answer(query.id, "Не узнаю тебя");
    return;
  }

  const [, habitId, date, flag] = query.data.split(":");
  const stats = await fetchStats();
  const habit = stats.habits.find((h) => h.id === habitId);

  // Guards against a button forwarded to the wrong chat.
  if (!habit || habit.participantId !== participant.id) {
    await answer(query.id, "Это не твоя привычка");
    return;
  }

  const previous = statusOn(habit, date);
  if (!previous || !isOpen(stats, date)) {
    await answer(query.id, "День уже закрыт");
    await refresh(query, stats, participant, date);
    return;
  }

  const success = flag === "1";
  const changed = previous !== (success ? "success" : "fail");

  if (changed) {
    await db("checkins?on_conflict=habit_id,date", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ habit_id: habit.id, date, success }),
    });
  }

  const updated = changed ? await fetchStats() : stats;
  await answer(query.id);
  // Refresh even when nothing changed: the day may have been answered in
  // another copy of this message, leaving this one stale. When it is already
  // current, Telegram rejects the edit as "message is not modified" — that
  // logged error is expected.
  await refresh(query, updated, participant, date);

  // Personal habits stay personal — only shared ones are worth nudging the
  // other person about.
  if (!changed || !habit.isShared) return;

  const action = previous === "pending"
    ? byGender(participant.gender, "отметил", "отметила")
    : byGender(participant.gender, "исправил", "исправила");

  const others = await db(
    `participants?id=neq.${participant.id}&select=telegram_chat_id`,
  ) as Array<Pick<Participant, "telegram_chat_id">>;

  for (const other of others) {
    await telegram("sendMessage", {
      chat_id: other.telegram_chat_id,
      text: `${participant.name} ${action} ${formatDate(date)}: ` +
        `${habit.emoji} ${habit.title} — ${verdict(success, participant.gender)}\n` +
        `Вместе: ${days(updated.pair.currentStreak)} подряд`,
    });
  }
}

async function notifyAdmin(message: IncomingMessage): Promise<void> {
  const from = message.from;
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || "без имени";
  const username = from?.username ? ` (@${from.username})` : "";
  const text = message.text ? `\nТекст: ${message.text.slice(0, 200)}` : "";

  await telegram("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: `Боту написал незнакомый человек: ${name}${username}\nchat_id: ${message.chat.id}${text}`,
  });
}

async function handleMessage(message: IncomingMessage): Promise<void> {
  const chatId = message.chat.id;
  const participant = await findParticipant(chatId);

  if (!participant) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `Этот бот приватный.\nТвой chat_id: ${chatId}`,
    });
    await notifyAdmin(message);
    return;
  }

  // Only a status, never buttons: days are answered from the morning message.
  const stats = await fetchStats();
  const pending = pendingDates(stats, participant.id);
  const status = pending.length > 0
    ? `${participant.name}, не отмечено: ${pending.map(formatDate).join(", ")}.\n` +
      `Отметить можно кнопками в утреннем сообщении — оно приходит в 10:00.`
    : `${participant.name}, все дни отмечены. Завтра в 10:00 спрошу про сегодня.`;

  await telegram("sendMessage", {
    chat_id: chatId,
    text: `${status}\n\nВся статистика на сайте:\n${SITE_URL}`,
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
