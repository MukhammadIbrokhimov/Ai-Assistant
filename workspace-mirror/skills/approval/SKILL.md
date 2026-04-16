# Approval Skill

Sends a draft to Telegram for human review with inline keyboard buttons (Approve/Modify/Reject). Creates `state.json` to track the Telegram message.

## Usage

```js
import { sendForApproval } from "./approval.js";
await sendForApproval(draftId, { telegramClient, draftStore, chatId });
```
