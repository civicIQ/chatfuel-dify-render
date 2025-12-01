const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --- ENV VARS ---
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const CHATFUEL_BOT_ID = process.env.CHATFUEL_BOT_ID;
const CHATFUEL_TOKEN = process.env.CHATFUEL_TOKEN;
const CHATFUEL_ANSWER_BLOCK_ID = process.env.CHATFUEL_ANSWER_BLOCK_ID;

//validating API KEY 
if (!DIFY_API_KEY) {
  console.warn("DIFY_API_KEY is not set");
}
if (!CHATFUEL_BOT_ID || !CHATFUEL_TOKEN || !CHATFUEL_ANSWER_BLOCK_ID) {
  console.warn("Chatfuel broadcast env vars are not fully set");
}

//function to format messages 
function formatForMessenger(text) {
  if (!text) return text;

  let result = text;
  const INDENT = "\u2003\u2003"; // two EM spaces
  result = result.replace(/^[\*\-]\s+/gm, `${INDENT}• `);

  result = result.replace(/\*\*(.*?)\*\*/g, "$1"); 
  result = result.replace(/\*(.*?)\*/g, "$1");     
  result = result.replace(/_(.*?)_/g, "$1");       

  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  result = result.replace(/ +\n/g, "\n");
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}


async function callDifyWithFallback(payload, conversationId) {
  try {
    //Case 1: chat-messages with conversation_id
    return await axios.post("https://api.dify.ai/v1/chat-messages", payload, {
      headers: {
        Authorization: `Bearer ${DIFY_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 120000
    });
  } catch (err) {
    //validating response
    const status = err?.response?.status; 
    //validating data 
    const code = err?.response?.data?.code;

    //Case 2: chat-messages without conversation_id
    if (status === 404 && code === "not_found" && conversationId) {
      console.error(
        "Dify says conversation does not exist, retrying without conversation_id:",
        conversationId
      );

      const retryPayload = { ...payload };
      delete retryPayload.conversation_id;

      return await axios.post(
        "https://api.dify.ai/v1/chat-messages",
        retryPayload,
        {
          headers: {
            Authorization: `Bearer ${DIFY_API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 120000
        }
      );
    }

    throw err;
  }

}

//Health check 
app.get("/", (req, res) => {
  res.send("Chatfuel ↔ Dify Render bridge is running.");
});

//Main endpoint that Chatfuel JSON API will call
app.post("/chatfuel", async (req, res) => {

  //Read input from Chatfuel
  const rawText =
    (req.body && (req.body.user_text || req.body["chatfuel user input"])) || "";
  const userText = String(rawText).trim();

  let conversationId = (req.body && req.body.dify_conversation_id) || null;

  if (
    !conversationId ||
    String(conversationId).trim() === "" ||
    String(conversationId).toLowerCase() === "null"
  ) {
    conversationId = null;
  }

  const userId =
    (req.body &&
      (req.body.chatfuel_user_id || req.body.messenger_user_id)) ||
    null;

  const extraInputs = (req.body && req.body.inputs) || {};
  const inputs = { from_channel: "chatfuel", ...extraInputs };

  //messages are longer  
  res.json({
    messages: [
      {
        text:
          "Thinking… I'll reply shortly!"
      }
    ]
  });

  //If we don't have a userId, we can't push later
  if (!userId) {
    console.warn("Missing userId, can't send follow-up via broadcast.");
    return;
  }

  //Continue in the background: call Dify
  try {
    
    const payload = {
        query: userText,
        response_mode: "blocking", //full answer
        user: String(userId),
        inputs
    };
    if (conversationId) payload.conversation_id = conversationId;

    //there is no converstion id in dify 
    const dfy = await callDifyWithFallback(payload, conversationId);

    const rawAns =
    dfy.data?.answer ??
    dfy.data?.outputs?.text ??
    "No answer returned from Dify.";

    const ans = formatForMessenger(rawAns);

    const nextConversationId = dfy.data?.conversation_id || conversationId || "";

    //Push final answer back to user using Chatfuel Broadcast API
    if (!CHATFUEL_BOT_ID || !CHATFUEL_TOKEN || !CHATFUEL_ANSWER_BLOCK_ID) {
      console.warn(
        "Chatfuel broadcast env vars missing; can't send final answer."
      );
      return;
    }

    const broadcastUrl = `https://api.chatfuel.com/bots/${CHATFUEL_BOT_ID}/users/${encodeURIComponent(
      userId
    )}/send`;

    await axios.post(
    broadcastUrl,
    {
        //attributes to set for this user
        dify_answer: ans,
        dify_conversation_id: nextConversationId
    },
    {
        params: {
        chatfuel_token: CHATFUEL_TOKEN,
        chatfuel_block_id: CHATFUEL_ANSWER_BLOCK_ID
        },
        headers: {
        "Content-Type": "application/json"
        },
        timeout: 10000
    }
  );
    console.log("Sent final answer via Chatfuel broadcast", {
      userId,
      nextConversationId
    });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    const url = err?.config?.url;
    console.error(
      "Error in background Dify/Broadcast flow:",
    status,
    url,
    typeof data === "string" ? data : JSON.stringify(data)
    );
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
