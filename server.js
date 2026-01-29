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
if (!CHATFUEL_BOT_ID || !CHATFUEL_TOKEN) {
  console.warn("Chatfuel bot ID or token is not set");
}



// function to format messages 
function formatForMessenger(text) {
  if (!text) {
    return text;
  }

  let result = text;

  //markers for citations
  const superNums = ["¹","²","³","⁴","⁵","⁶","⁷","⁸","⁹","¹⁰","¹¹","¹²","¹³","¹⁴","¹⁵"];

  const citations = [];
  const urlToMarker = {};

  function registerCitation(url, label) {
    if (!urlToMarker[url]) {
      const idx = citations.length;
      const marker = superNums[idx] || `[${idx + 1}]`;
      urlToMarker[url] = marker;
      citations.push({
        marker,
        url,
        label: (label || "").trim() || "Source"
      });
    }
    return urlToMarker[url];
  }

  const aTagRegex = /<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  result = result.replace(aTagRegex, (_, url, label) => {
    const marker = registerCitation(url, label);
    return marker; 
  });

  const bareUrlRegex = /https?:\/\/\S+/g;
  result = result.replace(bareUrlRegex, (url) => {
    const marker = registerCitation(url, "");
    return marker; 
  });

  //remove any remaining HTML tags
  result = result.replace(/<\/?[^>]+>/g, "");
  const INDENT = "\u2003\u2003"; 
  result = result.replace(/^[\*\-]\s+/gm, `${INDENT}• `);
  //remove single *italic*
  result = result.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1$2");
  //remove **bold**
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  //remove _italic_
  result = result.replace(/_(.*?)_/g, "$1");

  //delete any extra spaces
  result = result.replace(/ +\n/g, "\n");    
  result = result.replace(/\n{3,}/g, "\n\n"); 
  result = result.trim();
  //remove parentheses around citation markers
  result = result.replace(/\(\s*((?:[¹²³⁴⁵⁶⁷⁸⁹]|¹⁰|¹¹|¹²|¹³|¹⁴|¹⁵)(?:\s*;\s*(?:[¹²³⁴⁵⁶⁷⁸⁹]|¹⁰|¹¹|¹²|¹³|¹⁴|¹⁵))*)\s*\)/g, "$1");
  //replace ';'
  result = result.replace(/([¹²³⁴⁵⁶⁷⁸⁹]|¹⁰)(?:\s*;\s*)(?=[¹²³⁴⁵⁶⁷⁸⁹]|¹⁰)/g, "$1 ");
  //sources block
  let sourcesText = "";

  if (citations.length > 0) {
    citations.forEach(({ marker, url, label }) => {
      sourcesText += `${marker} ${label}\n${url}\n\n`;
    });
  }

  return {
    answer: result.trim(),
    sources: sourcesText.trim()
  };

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
  const flow = req.body.flow || "organic";
  const answerBlockId =
  req.body.answer_block_id || process.env.CHATFUEL_ANSWER_BLOCK_ID;
  console.log("Incoming Chatfuel request", {
    userId: req.body.chatfuel_user_id,
    flow,
    answerBlockId
  });
  if (!answerBlockId) {
    console.warn("No answer_block_id provided; using fallback");
  }
  const mode = flow.startsWith("ads") ? "ads" : "organic";
  const userId =
    (req.body &&
      (req.body.chatfuel_user_id || req.body.messenger_user_id)) ||
    null;
  let conversationId = req.body.dify_conversation_id;
  if (
    !conversationId ||
    String(conversationId).trim() === "" ||
    String(conversationId).toLowerCase() === "null"
  ) {
    conversationId = null;
  }

  

  const extraInputs = (req.body && req.body.inputs) || {};
  const inputs = {
    from_channel: "chatfuel",
    flow,
    ...extraInputs
  };


  //immediate response so Chatfuel doesn't show timeout
  res.json({
    messages: [
      {
        text: "Thinking…"
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

    const formatted = formatForMessenger(rawAns);
    const answerText = formatted.answer;
    const sourcesText = formatted.sources || "No sources provided.";


    const nextConversationId = dfy.data?.conversation_id || conversationId || "";

    //push final answer back to user
    if (!CHATFUEL_BOT_ID || !CHATFUEL_TOKEN) {
      console.warn(
        "Chatfuel bot ID or token missing; can't send final answer."
      );
      return;
    }

    const broadcastUrl = `https://api.chatfuel.com/bots/${CHATFUEL_BOT_ID}/users/${encodeURIComponent(
      userId
    )}/send`;

    const chunks = splitIntoChunks(answerText, 1500);
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
          dify_sources: sourcesText,
          dify_conversation_id: nextConversationId
        },
        {
          params: {
            chatfuel_token: CHATFUEL_TOKEN,
            chatfuel_block_id: answerBlockId
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
