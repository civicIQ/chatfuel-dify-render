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
  if (!text) {
    return text;
  }

  let result = text;
  //find all <a href="URL">text</a> links
  const aTagRegex = /<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  let match;
  const urls = [];
  const texts = [];
  const urlMap = {};
  const superNums = ["¹","²","³","⁴","⁵","⁶","⁷","⁸","⁹","¹⁰","¹¹","¹²","¹³","¹⁴","¹⁵"];
  let counter = 0;

  while ((match = aTagRegex.exec(result)) !== null) {
    const fullMatch = match[0];
    const url = match[1];
    const citationText = match[2];

    if (!urlMap[url]) {
      urlMap[url] = superNums[counter] || `(${counter + 1})`;
      urls.push(url);
      texts.push(citationText);
      counter++;
    }

    //replace the <a> tag in the text with the superscript number
    result = result.replace(fullMatch, urlMap[url]);
  }

  //remove any remaining HTML tags
  result = result.replace(/<\/?[^>]+>/g, "");

  const INDENT = "\u2003\u2003"; // two EM spaces
  result = result.replace(/^[\*\-]\s+/gm, `${INDENT}• `);
  result = result.replace(/<a\s+href="([^"]+)"[^>]*>(.*?)<\/a>/g, "$2: $1");
  // 1) convert *italic* -> _italic_
  result = result.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1_$2_");
  // 2) then convert **bold** -> *bold*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");  
  //clean up extra spaces or lines
  result = result.replace(/ +\n/g, "\n");
  result = result.replace(/\n{3,}/g, "\n\n");
  //sources
  if (urls.length > 0) {
    result += "\n\n---\n";
    urls.forEach((url, i) => {
      const marker = superNums[i] || `(${i+1})`;
      const text = texts[i];
      result += `${marker} ${text} ${url}\n`;
    });
  }

  return result.trim();
}

//split into chunks for larger answers
function splitIntoChunks(message, size = 1500) {
  const chunks = [];
  let remaining = message;

  while (remaining.length > size) {
    let cutIndex = remaining.lastIndexOf("\n", size);
    if (cutIndex === -1) {
      cutIndex = size;
    }
    chunks.push(remaining.slice(0, cutIndex).trim());
    remaining = remaining.slice(cutIndex).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
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
  //read input from Chatfuel
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

  //immediate response so Chatfuel doesn't show timeout
  res.json({
    messages: [
      {
        text: "Thinking… I'll reply shortly!"
      }
    ]
  });

  //if we don't have a userId, we can't push later
  if (!userId) {
    console.warn("Missing userId, can't send follow-up via broadcast.");
    return;
  }

  //call Dify
  try {
    const payload = {
      query: userText,
      response_mode: "blocking", 
      user: String(userId),
      inputs
    };
    if (conversationId) payload.conversation_id = conversationId;

    const dfy = await callDifyWithFallback(payload, conversationId);

    const rawAns =
      dfy.data?.answer ??
      dfy.data?.outputs?.text ??
      "No answer returned from Dify.";

    const ans = formatForMessenger(rawAns);

    const nextConversationId = dfy.data?.conversation_id || conversationId || "";

    //push final answer back to user
    if (!CHATFUEL_BOT_ID || !CHATFUEL_TOKEN || !CHATFUEL_ANSWER_BLOCK_ID) {
      console.warn(
        "Chatfuel broadcast env vars missing; can't send final answer."
      );
      return;
    }

    const broadcastUrl = `https://api.chatfuel.com/bots/${CHATFUEL_BOT_ID}/users/${encodeURIComponent(
      userId
    )}/send`;

    const chunks = splitIntoChunks(ans, 1500);
    console.log(
      "About to broadcast answer",
      {
        userId,
        nextConversationId,
        totalLength: ans.length,
        chunks: chunks.length
      }
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const broadcastResp = await axios.post(
        broadcastUrl,
        {
          dify_answer: chunk,
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

      console.log(
        `Sent chunk ${i + 1}/${chunks.length} via Chatfuel broadcast`,
        {
          userId,
          nextConversationId
        },
        "Chatfuel response:",
        broadcastResp.status,
        JSON.stringify(broadcastResp.data)
      );
    }
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
