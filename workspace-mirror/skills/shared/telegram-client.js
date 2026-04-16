export function createTelegramClient(token) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call(method, body) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      throw new Error(`Telegram ${method}: ${json.description || "unknown error"}`);
    }
    return json.result;
  }

  return {
    async sendMessage(chatId, text, opts = {}) {
      return call("sendMessage", {
        chat_id: chatId,
        text,
        ...opts,
      });
    },

    async editMessageText(chatId, messageId, text, opts = {}) {
      return call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...opts,
      });
    },

    async answerCallbackQuery(callbackQueryId, text) {
      return call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
      });
    },

    async getUpdates(offset, timeout) {
      return call("getUpdates", {
        offset,
        timeout,
        allowed_updates: ["message", "callback_query"],
      });
    },
  };
}
