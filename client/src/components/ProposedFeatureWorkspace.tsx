import { useEffect, useMemo, useState } from "react";
import { Award, Bell, CalendarDays, Check, ChevronRight, Download, ExternalLink, GitCompareArrows, Megaphone, MessageCircle, RefreshCw, Send, ShieldCheck, Sparkles, Trophy, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { backendCreateAward, backendCreatePundit, backendDeleteAward, backendDownloadCalendar, backendGenerateEditorial, backendGetAwards, backendGetDiscordSettings, backendGetNotifications, backendGetPredictions, backendGetHeadToHead, backendMarkAllNotificationsRead, backendMarkNotificationRead, backendSaveDiscordSettings, backendSavePrediction, backendTestDiscord, type BackendEditorialDraft, type DiscordSettings, type FeatureAward, type HeadToHeadResult, type PredictionDashboard, type ProposedNotification } from "@/lib/backend-api";
import type { LeagueDatabase, Match, Team, UserAccount } from "@/lib/league-db";
import { toast } from "sonner";

type FeatureTab = "signals" | "predictions" | "awards" | "head-to-head" | "integrations" | "ai-analysis";

type Props = {
  database: LeagueDatabase;
  user: UserAccount;
  isAdmin: boolean;
  seasonId: number | null;
  onOpenMatch: (matchId: string) => void;
};

function dateTime(value: number) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function matchTitle(database: LeagueDatabase, match: Match) {
  const home = database.teams.find((team) => team.id === match.homeTeamId)?.shortName || "Home";
  const away = database.teams.find((team) => team.id === match.awayTeamId)?.shortName || "Away";
  return `${home} vs ${away}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ProposedFeatureWorkspace({ database, user, isAdmin, seasonId, onOpenMatch }: Props) {
  const [tab, setTab] = useState<FeatureTab>("signals");
  const [notifications, setNotifications] = useState<ProposedNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [predictions, setPredictions] = useState<PredictionDashboard | null>(null);
  const [awards, setAwards] = useState<FeatureAward[]>([]);
  const [headToHead, setHeadToHead] = useState<HeadToHeadResult | null>(null);
  const [teamA, setTeamA] = useState("");
  const [teamB, setTeamB] = useState("");
  const [discord, setDiscord] = useState<DiscordSettings | null>(null);
  const [discordUrl, setDiscordUrl] = useState("");
  const [discordLabel, setDiscordLabel] = useState("League Discord");
  const [discordEnabled, setDiscordEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [predictionInputs, setPredictionInputs] = useState<Record<string, { home: string; away: string }>>({});
  const [awardSubject, setAwardSubject] = useState("");
  const [awardCitation, setAwardCitation] = useState("");
  const [awardType, setAwardType] = useState("PLAYER_OF_MATCHDAY");
  const [aiDraft, setAiDraft] = useState<BackendEditorialDraft | null>(null);

  const upcomingOwnedMatches = useMemo(() => database.matches.filter((match) => (match.status === "SCHEDULED" || match.status === "POSTPONED") && Boolean(user.teamId && (match.homeTeamId === user.teamId || match.awayTeamId === user.teamId))).slice(0, 8), [database.matches, user.teamId]);
  const editorials = (database.punditEditorials || []).slice(0, 5);
  const currentMatchday = useMemo(() => Math.max(1, ...database.matches.map((match) => Number(match.matchday) || 1)), [database.matches]);

  async function loadFeatures() {
    setBusy(true);
    try {
      const [notificationResult, predictionResult, awardResult] = await Promise.all([backendGetNotifications(), backendGetPredictions(seasonId || undefined), backendGetAwards(seasonId || undefined)]);
      setNotifications(notificationResult.notifications);
      setUnreadCount(notificationResult.unreadCount);
      setPredictions(predictionResult);
      setAwards(awardResult.awards);
      if (isAdmin) {
        const settings = await backendGetDiscordSettings();
        setDiscord(settings); setDiscordLabel(settings.label); setDiscordEnabled(settings.enabled);
      }
    } catch (error) {
      toast.error("Could not load league tools", { description: error instanceof Error ? error.message : "Try again shortly." });
    } finally { setBusy(false); }
  }

  useEffect(() => { void loadFeatures(); }, [seasonId, user.email, isAdmin]);

  async function markRead(notification: ProposedNotification) {
    if (notification.read) return;
    try { await backendMarkNotificationRead(notification.id); setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, read: true } : item)); setUnreadCount((current) => Math.max(0, current - 1)); } catch (error) { toast.error(error instanceof Error ? error.message : "Notification could not be marked read."); }
  }

  async function markAllRead() {
    try { await backendMarkAllNotificationsRead(); setNotifications((current) => current.map((item) => ({ ...item, read: true }))); setUnreadCount(0); } catch (error) { toast.error(error instanceof Error ? error.message : "Notifications could not be updated."); }
  }

  async function savePrediction(match: Match) {
    const input = predictionInputs[match.id] || { home: "", away: "" };
    const home = Number(input.home); const away = Number(input.away);
    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) { toast.error("Enter two whole-number scores."); return; }
    setBusy(true);
    try { await backendSavePrediction(Number(match.id), home, away); toast.success("Prediction saved", { description: "You can update it until kickoff." }); await loadFeatures(); } catch (error) { toast.error("Prediction not saved", { description: error instanceof Error ? error.message : "Try again." }); } finally { setBusy(false); }
  }

  async function saveAward() {
    if (!seasonId || !awardSubject.trim() || !awardCitation.trim()) { toast.error("Choose a season and complete the award details."); return; }
    setBusy(true);
    try { await backendCreateAward({ seasonId, matchday: currentMatchday, awardType, subjectName: awardSubject.trim(), citation: awardCitation.trim() }); setAwardSubject(""); setAwardCitation(""); toast.success("Award published"); await loadFeatures(); } catch (error) { toast.error("Award could not be published", { description: error instanceof Error ? error.message : "Try again." }); } finally { setBusy(false); }
  }

  async function removeAward(id: number) {
    try { await backendDeleteAward(id); setAwards((current) => current.filter((award) => award.id !== id)); toast.success("Award removed"); } catch (error) { toast.error(error instanceof Error ? error.message : "Award could not be removed."); }
  }

  async function loadH2H() {
    if (!teamA || !teamB || teamA === teamB) { toast.error("Choose two different teams."); return; }
    setBusy(true);
    try { setHeadToHead(await backendGetHeadToHead(Number(teamA), Number(teamB))); } catch (error) { toast.error("Head-to-head data unavailable", { description: error instanceof Error ? error.message : "Try again." }); } finally { setBusy(false); }
  }

  async function saveDiscord() {
    setBusy(true);
    try { const result = await backendSaveDiscordSettings({ webhookUrl: discordUrl, enabled: discordEnabled, label: discordLabel }); setDiscord(result); toast.success("Discord settings saved"); } catch (error) { toast.error("Discord settings could not be saved", { description: error instanceof Error ? error.message : "Try again." }); } finally { setBusy(false); }
  }

  async function testDiscord() {
    setBusy(true);
    try { const result = await backendTestDiscord(); toast.success(result.posted ? "Test posted to Discord" : "Discord posting is disabled"); } catch (error) { toast.error("Discord test failed", { description: error instanceof Error ? error.message : "Check the webhook URL." }); } finally { setBusy(false); }
  }

  async function downloadCalendar() {
    try { const result = await backendDownloadCalendar(seasonId || undefined); downloadBlob(result.blob, result.filename); toast.success("Calendar downloaded", { description: "Import eleague-fixtures.ics into your calendar app." }); } catch (error) { toast.error("Calendar export failed", { description: error instanceof Error ? error.message : "Try again." }); }
  }

  async function generateEditorialDraft() {
    if (!isAdmin) return;
    setBusy(true);
    try { const result = await backendGenerateEditorial(); setAiDraft(result.draft); toast.success("Chronicle draft generated", { description: "Review the evidence and edit the copy before publishing." }); } catch (error) { toast.error("AI analysis could not be generated", { description: error instanceof Error ? error.message : "Try again shortly." }); } finally { setBusy(false); }
  }

  function updateEditorialDraft(field: "headline" | "dek" | "body", value: string) {
    setAiDraft((current) => {
      if (!current) return current;
      const next = { ...current, [field]: value };
      const leadStory = current.editorial.leadStory || { tag: "LEAD STORY" };
      next.editorial = { ...current.editorial, leadStory: { ...leadStory, headline: field === "headline" ? value : current.headline, subdeck: field === "dek" ? value : current.dek, body: field === "body" ? value : current.body, bodyParagraphs: (field === "body" ? value : current.body).split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean) } };
      return next;
    });
  }

  async function publishEditorialDraft() {
    if (!isAdmin || !aiDraft || !seasonId) { toast.error("A season and a generated draft are required."); return; }
    setBusy(true);
    try {
      await backendCreatePundit({ seasonId, publishDate: new Date().toISOString().slice(0, 10), section: "AI DATA DESK", headline: aiDraft.headline.trim(), dek: aiDraft.dek.trim(), body: aiDraft.body.trim(), imageKey: "goal-celebration", facts: aiDraft.facts, editorial: aiDraft.editorial });
      setAiDraft(null);
      toast.success("Draft published to the Chronicle", { description: "The approved editorial is now available in the player-facing magazine." });
    } catch (error) { toast.error("Draft was not published", { description: error instanceof Error ? error.message : "Review the copy and try again." }); } finally { setBusy(false); }
  }

  const tabs: Array<{ id: FeatureTab; label: string; icon: typeof Bell; hint: string }> = [
    { id: "signals", label: "Signals", icon: Bell, hint: "Notifications and editorials" },
    { id: "predictions", label: "Predictions", icon: Sparkles, hint: "Scoreline mini-game" },
    { id: "awards", label: "Awards", icon: Trophy, hint: "Matchday honours" },
    { id: "head-to-head", label: "Head-to-head", icon: GitCompareArrows, hint: "Team comparison" },
    ...(isAdmin ? [{ id: "ai-analysis" as const, label: "AI Analysis", icon: Sparkles, hint: "Grounded Chronicle desk" }] : []),
    { id: "integrations", label: "Integrations", icon: Megaphone, hint: "Discord and calendar" },
  ];

  return <section className="view-panel proposed-workspace">
    <div className="feature-hero"><div><p className="eyebrow">LEAGUE TOOLS / NEW</p><h2>Signals beyond the scoreboard.</h2><p>Predictions, evidence, awards, editorial takes, and team history now live in one connected matchday workspace.</p></div><div className="feature-hero-mark"><Sparkles size={28} /><span>{unreadCount ? `${unreadCount} unread signals` : "League intelligence"}</span></div></div>
    <div className="feature-tabs" role="tablist" aria-label="League tools">{tabs.map(({ id, label, icon: Icon, hint }) => <button type="button" key={id} className={tab === id ? "selected" : ""} onClick={() => setTab(id)} role="tab" aria-selected={tab === id}><Icon size={16} /><span>{label}</span><small>{hint}</small></button>)}</div>
    {tab === "signals" && <div className="feature-columns"><section className="feature-card"><div className="feature-card-heading"><div><p className="eyebrow">NOTIFICATION CENTRE</p><h3>League signals</h3></div><div className="feature-heading-actions"><span className="feature-count">{unreadCount} unread</span><button type="button" className="text-button" onClick={markAllRead} disabled={!unreadCount}>Mark all read</button></div></div>{notifications.length ? <div className="notification-feed">{notifications.map((notification) => <button type="button" className={`notification-row ${notification.read ? "is-read" : "is-unread"}`} key={notification.id} onClick={() => { void markRead(notification); const matchId = Number(notification.payload.matchId); if (Number.isInteger(matchId)) onOpenMatch(String(matchId)); }}><span className="notification-row-icon">{notification.type === "RESULT_CONFIRMED" ? <Check size={15} /> : notification.type === "PROOF_SUBMITTED" ? <ShieldCheck size={15} /> : <Bell size={15} />}</span><span><strong>{notification.title}</strong><small>{notification.body}</small><time>{dateTime(notification.createdAt)}</time></span><ChevronRight size={15} /></button>)}</div> : <Empty className="feature-empty"><EmptyHeader><EmptyMedia variant="icon"><Bell size={20} /></EmptyMedia><EmptyTitle>No signals yet</EmptyTitle><EmptyDescription>Match submissions, confirmations, and evidence reviews will appear here.</EmptyDescription></EmptyHeader></Empty>}</section><section className="feature-card editorial-signal-card"><div className="feature-card-heading"><div><p className="eyebrow">PUNDIT PICKS</p><h3>Inside the Chronicle</h3></div><MessageCircle size={18} /></div>{editorials.length ? editorials.map((editorial) => <article className="pundit-mini-card" key={editorial.id}><span>{editorial.section}</span><h4>{editorial.headline}</h4><p>{editorial.dek || editorial.body.slice(0, 180)}</p><small>{editorial.publishDate}</small></article>) : <Empty className="feature-empty"><EmptyHeader><EmptyMedia variant="icon"><MessageCircle size={20} /></EmptyMedia><EmptyTitle>No pundit picks yet</EmptyTitle><EmptyDescription>Admin editorials published in the Chronicle will be surfaced here.</EmptyDescription></EmptyHeader></Empty>}</section></div>}
    {tab === "predictions" && <div className="feature-columns"><section className="feature-card"><div className="feature-card-heading"><div><p className="eyebrow">MATCHDAY MINI-GAME</p><h3>Predict the score</h3></div><Sparkles size={18} /></div>{upcomingOwnedMatches.length ? <div className="prediction-list">{upcomingOwnedMatches.map((match) => { const current = predictions?.mine.find((prediction) => prediction.matchId === Number(match.id)); const values = predictionInputs[match.id] || { home: current ? String(current.homeScore) : "", away: current ? String(current.awayScore) : "" }; return <article className="prediction-card" key={match.id}><div><span className="eyebrow">MATCHDAY {match.matchday}</span><h4>{matchTitle(database, match)}</h4><small>Closes at kickoff · exact score earns 5 points</small></div><div className="prediction-inputs"><input aria-label="Home prediction" inputMode="numeric" value={values.home} onChange={(event) => setPredictionInputs((state) => ({ ...state, [match.id]: { ...values, home: event.target.value } }))} placeholder="0" /><b>–</b><input aria-label="Away prediction" inputMode="numeric" value={values.away} onChange={(event) => setPredictionInputs((state) => ({ ...state, [match.id]: { ...values, away: event.target.value } }))} placeholder="0" /><Button onClick={() => void savePrediction(match)} disabled={busy}><Send size={14} /> Save</Button></div></article>; })}</div> : <Empty className="feature-empty"><EmptyHeader><EmptyMedia variant="icon"><Sparkles size={20} /></EmptyMedia><EmptyTitle>No eligible fixtures</EmptyTitle><EmptyDescription>Predictions open for your team’s scheduled fixtures until kickoff.</EmptyDescription></EmptyHeader></Empty>}</section><section className="feature-card"><div className="feature-card-heading"><div><p className="eyebrow">LEAGUE LADDER</p><h3>Prediction leaderboard</h3></div><Trophy size={18} /></div>{predictions?.leaderboard.length ? <div className="prediction-leaderboard">{predictions.leaderboard.map((row) => <div className="prediction-rank-row" key={row.email}><strong>{row.rank}</strong><span><b>{row.displayName}</b><small>{row.predictions} predictions · {row.scoredPredictions} scored</small></span><em>{row.points} pts</em></div>)}</div> : <Empty className="feature-empty"><EmptyHeader><EmptyMedia variant="icon"><Trophy size={20} /></EmptyMedia><EmptyTitle>Leaderboard starts after results</EmptyTitle><EmptyDescription>Confirmed fixtures score the prediction table.</EmptyDescription></EmptyHeader></Empty>}</section></div>}
    {tab === "awards" && <div className="feature-columns"><section className="feature-card"><div className="feature-card-heading"><div><p className="eyebrow">MATCHDAY HONOURS</p><h3>Hall of Fame</h3></div><Award size={18} /></div>{awards.length ? <div className="award-list">{awards.map((award) => <article className="award-row" key={award.id}><span className="award-medal"><Trophy size={17} /></span><span><small>MD{award.matchday} · {award.awardType.replaceAll("_", " ")}</small><strong>{award.subjectName}</strong><p>{award.citation}</p></span>{isAdmin && <button className="icon-button danger-icon" type="button" aria-label={`Delete ${award.subjectName} award`} onClick={() => void removeAward(award.id)}><X size={15} /></button>}</article>)}</div> : <Empty className="feature-empty"><EmptyHeader><EmptyMedia variant="icon"><Award size={20} /></EmptyMedia><EmptyTitle>No awards published</EmptyTitle><EmptyDescription>Matchday awards become a permanent league record once an admin publishes them.</EmptyDescription></EmptyHeader></Empty>}</section>{isAdmin && <section className="feature-card"><div className="feature-card-heading"><div><p className="eyebrow">ADMIN EDITOR</p><h3>Publish an honour</h3></div><ShieldCheck size={18} /></div><div className="feature-form"><label>Award type<select value={awardType} onChange={(event) => setAwardType(event.target.value)}><option value="PLAYER_OF_MATCHDAY">Player of the matchday</option><option value="TEAM_OF_MATCHDAY">Team of the matchday</option><option value="GOAL_OF_MATCHDAY">Goal of the matchday</option><option value="PUNDIT_PICK">Pundit pick</option></select></label><label>Subject<input value={awardSubject} onChange={(event) => setAwardSubject(event.target.value)} placeholder="Player, team, or moment" /></label><label>Citation<textarea value={awardCitation} onChange={(event) => setAwardCitation(event.target.value)} placeholder="What did the data prove?" rows={4} /></label><Button onClick={() => void saveAward()} disabled={busy}><Award size={15} /> Publish award</Button></div></section>}</div>}
    {tab === "head-to-head" && <section className="feature-card h2h-card"><div className="feature-card-heading"><div><p className="eyebrow">RIVALRY FILE</p><h3>Head-to-head</h3><p>Compare confirmed meetings, wins, draws, and goals between any two teams.</p></div><GitCompareArrows size={20} /></div><div className="h2h-controls"><label>Team A<select value={teamA} onChange={(event) => setTeamA(event.target.value)}><option value="">Choose team</option>{database.teams.map((team) => <option value={team.id} key={`a-${team.id}`}>{team.name}</option>)}</select></label><span>VS</span><label>Team B<select value={teamB} onChange={(event) => setTeamB(event.target.value)}><option value="">Choose team</option>{database.teams.map((team) => <option value={team.id} key={`b-${team.id}`}>{team.name}</option>)}</select></label><Button onClick={() => void loadH2H()} disabled={busy || !teamA || !teamB}><GitCompareArrows size={15} /> Compare</Button></div>{headToHead ? <div className="h2h-result"><div className="h2h-scoreboard"><div><strong>{headToHead.aggregate.teamA.wins}</strong><span>wins</span></div><div><strong>{headToHead.aggregate.teamA.draws}</strong><span>draws</span></div><div><strong>{headToHead.aggregate.teamB.wins}</strong><span>wins</span></div></div><div className="h2h-meetings">{headToHead.meetings.length ? headToHead.meetings.map((meeting) => <button type="button" key={meeting.id} className="h2h-meeting" onClick={() => onOpenMatch(String(meeting.id))}><span>MD{meeting.matchday}</span><strong>{meeting.homeTeamName} {meeting.homeScore}–{meeting.awayScore} {meeting.awayTeamName}</strong><ChevronRight size={14} /></button>) : <p className="muted-copy">No confirmed meetings between these teams yet.</p>}</div></div> : <Empty className="feature-empty"><EmptyHeader><EmptyMedia variant="icon"><GitCompareArrows size={20} /></EmptyMedia><EmptyTitle>Choose two teams</EmptyTitle><EmptyDescription>The rivalry file will show every confirmed meeting and aggregate record.</EmptyDescription></EmptyHeader></Empty>}</section>}
    {tab === "ai-analysis" && isAdmin && <div className="feature-columns ai-analysis-layout"><section className="feature-card"><div className="feature-card-heading"><div><p className="eyebrow">ADMIN EDITORIAL DESK</p><h3>Grounded Chronicle analysis</h3><p>Generate a data-backed story from confirmed league records, then review every line before it reaches the player-facing Chronicle.</p></div><Sparkles size={20} /></div><Button onClick={() => void generateEditorialDraft()} disabled={busy || !seasonId}><Sparkles size={15} /> {busy ? "Analysing verified data…" : "Generate Chronicle draft"}</Button>{aiDraft ? <><div className="ai-evidence-summary"><div><span>CONFIRMED</span><strong>{aiDraft.evidence.confirmedMatches}/{aiDraft.evidence.totalMatches}</strong><small>matches recorded</small></div><div><span>TABLE LEADER</span><strong>{String(aiDraft.evidence.standings[0]?.name || "—")}</strong><small>{String(aiDraft.evidence.facts.leader || "No leader fact yet")}</small></div><div><span>TOP SCORER</span><strong>{String(aiDraft.evidence.topScorers[0]?.name || "—")}</strong><small>{String(aiDraft.evidence.facts.top_scorer || "No scorer fact yet")}</small></div></div><div className="ai-evidence-list"><p className="eyebrow">VERIFIED EVIDENCE</p>{Object.entries(aiDraft.evidence.facts).map(([key, value]) => <div key={key}><span>{key.replaceAll("_", " ")}</span><p>{value}</p></div>)}</div><p className="form-help">Source snapshot: {aiDraft.evidence.asOfDate} · {aiDraft.model} · generated {dateTime(aiDraft.generatedAt)}</p><div className="ai-prediction-review"><div className="feature-card-heading"><div><p className="eyebrow">UPCOMING FIXTURE INTELLIGENCE</p><h3>Predictions & verified facts</h3></div><CalendarDays size={18} /></div><div className="ai-prediction-review-grid">{aiDraft.predictions.length ? aiDraft.predictions.map((prediction) => <article key={`${prediction.matchday}-${prediction.fixture}`}><div className="prediction-card-top"><span>MD {prediction.matchday} · {prediction.date}</span><b className={`prediction-confidence confidence-${prediction.confidence.toLowerCase()}`}>{prediction.confidence}</b></div><strong>{prediction.fixture}</strong><em>{prediction.pick}</em><p>{prediction.rationale}</p></article>) : <p className="muted-copy">No upcoming fixtures are available for a prediction.</p>}</div>{aiDraft.upcomingFixtureFacts.length ? <div className="ai-fixture-facts-review">{aiDraft.upcomingFixtureFacts.map((item) => <article key={`${item.matchday}-${item.fixture}`}><span>MD {item.matchday} · {item.date}</span><strong>{item.fixture}</strong><ul>{item.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul></article>)}</div> : null}<p className="form-help">These forecasts use confirmed standings and performance totals. They are predictions, not match results, and remain unpublished until approval.</p></div></> : <Empty className="feature-empty"><EmptyHeader><EmptyMedia variant="icon"><ShieldCheck size={20} /></EmptyMedia><EmptyTitle>Awaiting an editorial pass</EmptyTitle><EmptyDescription>The generator can only use the verified standings, confirmed results, scorers, and scheduled fixtures shown in the evidence snapshot.</EmptyDescription></EmptyHeader></Empty>}</section><section className="feature-card"><div className="feature-card-heading"><div><p className="eyebrow">REVIEW BEFORE PUBLISH</p><h3>{aiDraft ? "Edit the Chronicle draft" : "No draft in review"}</h3></div><MessageCircle size={18} /></div>{aiDraft ? <div className="feature-form"><label>Headline<input value={aiDraft.headline} maxLength={180} onChange={(event) => updateEditorialDraft("headline", event.target.value)} /></label><label>Standfirst / dek<textarea value={aiDraft.dek} maxLength={280} rows={3} onChange={(event) => updateEditorialDraft("dek", event.target.value)} /></label><label>Body<textarea value={aiDraft.body} maxLength={20000} rows={14} onChange={(event) => updateEditorialDraft("body", event.target.value)} /></label><div className="inline-form-actions"><Button onClick={() => void publishEditorialDraft()} disabled={busy || !aiDraft.headline.trim() || !aiDraft.dek.trim() || !aiDraft.body.trim()}><Check size={15} /> Approve & publish</Button><Button variant="outline" onClick={() => setAiDraft(null)} disabled={busy}><X size={15} /> Discard draft</Button></div><p className="form-help">Publishing sends this reviewed copy through the existing Chronicle editorial path. AI generation itself never publishes automatically.</p></div> : <Empty className="feature-empty"><EmptyHeader><EmptyMedia variant="icon"><MessageCircle size={20} /></EmptyMedia><EmptyTitle>Review queue is clear</EmptyTitle><EmptyDescription>Generate a draft to inspect the evidence, edit the copy, and approve it for publication.</EmptyDescription></EmptyHeader></Empty>}</section></div>}
    {tab === "integrations" && <div className="feature-columns"><section className="feature-card"><div className="feature-card-heading"><div><p className="eyebrow">CALENDAR EXPORT</p><h3>Keep the season in view</h3><p>Download an .ics file containing your team’s scheduled fixtures.</p></div><CalendarDays size={18} /></div><Button onClick={() => void downloadCalendar()}><Download size={15} /> Download calendar</Button><p className="form-help">Works with Google Calendar, Apple Calendar, Outlook, and other standard calendar clients.</p></section>{isAdmin && <section className="feature-card"><div className="feature-card-heading"><div><p className="eyebrow">DISCORD BROADCAST</p><h3>{discord?.label || "League Discord"}</h3><p>Post confirmed result headlines to a private Discord channel through a one-way webhook.</p></div><Megaphone size={18} /></div><div className="feature-form"><label>Webhook URL<input type="url" value={discordUrl} onChange={(event) => setDiscordUrl(event.target.value)} placeholder="https://discord.com/api/webhooks/..." /></label><label>Channel label<input value={discordLabel} onChange={(event) => setDiscordLabel(event.target.value)} placeholder="League Discord" /></label><label className="checkbox-line"><input type="checkbox" checked={discordEnabled} onChange={(event) => setDiscordEnabled(event.target.checked)} /> Enable confirmed-result posts</label><div className="inline-form-actions"><Button onClick={() => void saveDiscord()} disabled={busy}><Check size={15} /> Save settings</Button><Button variant="outline" onClick={() => void testDiscord()} disabled={busy || !discord?.configured}><Send size={15} /> Send test</Button></div><p className="form-help">The webhook is stored server-side and never returned to the browser after saving.</p></div></section>}</div>}
    <div className="feature-refresh-row"><span><ShieldCheck size={14} /> {user.role === "admin" ? "Admin tools are enabled" : "Player tools are read-safe"}</span><button type="button" className="text-button" onClick={() => void loadFeatures()} disabled={busy}><RefreshCw size={14} className={busy ? "spin" : ""} /> Refresh feature data</button></div>
  </section>;
}
