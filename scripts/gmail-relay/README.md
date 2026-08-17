# Free Gmail matchday relay

This relay lets the deployed eLeague app send the personalized HTML match cards through the Gmail account that owns the Apps Script project. It does not require a custom domain or a paid transactional-mail provider.

Google’s current Apps Script documentation lists a consumer-account quota of 100 email recipients per day and a maximum of 50 recipients per message. The relay therefore sends one message per player and refuses a batch larger than 50. Quotas can change and reset on Google’s schedule; use the relay health response or Apps Script execution history to monitor it.

## One-time setup

1. Sign in to [script.google.com](https://script.google.com/) as `peleefootball07@gmail.com` and create a new standalone Apps Script project.
2. Replace the starter code with `Code.gs` from this directory.
3. In **Project Settings → Script Properties**, add a property named `RELAY_SECRET`. Use a long random value. Do not commit the value to GitHub or put it in client-side code.
4. In **Deploy → New deployment**, select **Web app**. Set **Execute as** to **Me** (the Gmail account that will send the messages). Set access to **Anyone**. Deploy and authorize the requested mail-sending permission.
5. Copy the deployed `/exec` URL. Do not use the `/dev` test URL for Vercel production.
6. Add these Vercel **Production** environment variables and redeploy:

   - `GMAIL_RELAY_URL` = the deployed Apps Script `/exec` URL.
   - `GMAIL_RELAY_SECRET` = the exact same value used in the Apps Script `RELAY_SECRET` property.
   - `GMAIL_SENDER_EMAIL` = `peleefootball07@gmail.com`.
   - `GMAIL_SENDER_NAME` = `League'de Khalpar Matchday`.

## Safe verification

Open the deployed Apps Script `/exec` URL in a browser. It should return JSON showing `provider: "gmail_apps_script"`, `configured: true`, and the remaining quota. This health request sends no email.

Next, open the eLeague admin **Database → Matchday Mailroom** panel and press **Refresh preview**. The status should read **Gmail relay ready**. The **Notify players** button remains the only action that sends mail.

The server sends a stable `batchId` for each season/date/fixture set. The relay stores a result under that batch ID in Apps Script properties and returns the stored result for a repeated request, preventing duplicate sends when the admin accidentally clicks twice.

## Important limits

The relay is intended for the league’s small player list, not bulk marketing. Consumer Gmail/Apps Script quotas are daily recipient quotas and Google may change them. If the quota is exhausted, the relay returns a clear error and no messages are sent for that request.

The relay endpoint is public because the Vercel server must call it. The `RELAY_SECRET` check is mandatory. If the secret is ever exposed, replace it in both Apps Script properties and Vercel production variables before sending again.

## References

- [Google Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [Google Apps Script MailApp](https://developers.google.com/apps-script/reference/mail/mail-app)
- [Google Apps Script web apps](https://developers.google.com/apps-script/guides/web)
