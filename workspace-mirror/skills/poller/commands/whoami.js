export function createWhoamiCommand(pairedUserId) {
  return async function whoamiCommand(chatId, args, client) {
    await client.sendMessage(
      chatId,
      `Paired user ID: ${pairedUserId}\nStatus: ✅ paired`
    );
  };
}
