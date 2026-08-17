const MAX_MESSAGES_PER_BATCH = 50;
const MAX_SUBJECT_LENGTH = 180;
const MAX_BODY_LENGTH = 200000;
const DEFAULT_SENDER_NAME = "League'de Khalpar Matchday";

/**
 * Health endpoint. It intentionally reveals no secret and sends no email.
 */
function doGet() {
  return jsonResponse({
    ok: true,
    provider: "gmail_apps_script",
    configured: Boolean(getRelaySecret()),
    remainingQuota: safeRemainingQuota(),
  });
}

/**
 * Receives one personalized message per recipient from the eLeague server.
 * The script must be deployed as a web app executing as the owner account.
 */
function doPost(event) {
  try {
    const payload = parsePayload(event);
    const configuredSecret = getRelaySecret();
    if (!configuredSecret || payload.secret !== configuredSecret) {
      return jsonResponse({ ok: false, error: "Unauthorized relay request." });
    }

    const batchId = String(payload.batchId || "").trim();
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (!batchId || !messages.length) {
      return jsonResponse({ ok: false, error: "batchId and messages are required." });
    }
    if (messages.length > MAX_MESSAGES_PER_BATCH) {
      return jsonResponse({ ok: false, error: `A batch cannot contain more than ${MAX_MESSAGES_PER_BATCH} messages.` });
    }

    const dedupeKey = `eleague_batch_${batchId}`;
    const properties = PropertiesService.getScriptProperties();
    const previous = properties.getProperty(dedupeKey);
    if (previous) {
      const saved = JSON.parse(previous);
      return jsonResponse({ ...saved, alreadyProcessed: true });
    }

    const remainingBeforeSend = safeRemainingQuota();
    if (remainingBeforeSend < messages.length) {
      return jsonResponse({
        ok: false,
        error: `Gmail daily recipient quota is too low. Remaining: ${remainingBeforeSend}; required: ${messages.length}.`,
        remainingQuota: remainingBeforeSend,
      });
    }

    const failures = [];
    let sent = 0;
    const senderName = cleanText(payload.senderName, DEFAULT_SENDER_NAME, 120);
    messages.forEach(function(message) {
      const recipient = cleanText(message && message.to, "", 320);
      const subject = cleanText(message && message.subject, "eLeague next fixture", MAX_SUBJECT_LENGTH);
      const text = cleanText(message && message.text, "Your next eLeague fixture is ready.", MAX_BODY_LENGTH);
      const html = cleanText(message && message.html, "", MAX_BODY_LENGTH);
      if (!isValidEmail(recipient)) {
        failures.push({ email: recipient || "unknown recipient", reason: "Invalid recipient email address." });
        return;
      }
      if (!html) {
        failures.push({ email: recipient, reason: "HTML message body is empty." });
        return;
      }
      try {
        MailApp.sendEmail({
          to: recipient,
          subject: subject,
          body: text,
          htmlBody: html,
          name: senderName,
        });
        sent += 1;
      } catch (error) {
        failures.push({ email: recipient, reason: String(error && error.message ? error.message : error) });
      }
    });

    const result = {
      ok: sent > 0 && failures.length === 0,
      batchId: batchId,
      sent: sent,
      failed: failures,
      remainingQuota: safeRemainingQuota(),
    };
    properties.setProperty(dedupeKey, JSON.stringify(result));
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function getRelaySecret() {
  return String(PropertiesService.getScriptProperties().getProperty("RELAY_SECRET") || "").trim();
}

function parsePayload(event) {
  if (!event || !event.postData || !event.postData.contents) {
    throw new Error("JSON POST body is required.");
  }
  const payload = JSON.parse(event.postData.contents);
  if (!payload || typeof payload !== "object") throw new Error("JSON object is required.");
  return payload;
}

function cleanText(value, fallback, maxLength) {
  const text = String(value == null ? "" : value).trim();
  return (text || fallback).slice(0, maxLength);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeRemainingQuota() {
  try {
    return Number(MailApp.getRemainingDailyQuota()) || 0;
  } catch (error) {
    return -1;
  }
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
