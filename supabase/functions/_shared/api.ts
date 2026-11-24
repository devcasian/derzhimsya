import type { Stats } from "./checkin.ts";

export const SITE_URL = Deno.env.get("SITE_URL")!;

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export async function db(path: string, init: RequestInit = {}): Promise<unknown> {
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

export async function fetchStats(): Promise<Stats> {
  return await db("rpc/stats", { method: "POST", body: "{}" }) as Stats;
}

export async function telegram(method: string, payload: unknown): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`telegram ${method} failed:`, await res.text());
}
