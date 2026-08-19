import { Button } from "@/components/ui/button";
import {
  Activity,
  ArrowRight,
  ArrowUp,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Copy,
  Gauge,
  Quote,
  AlertTriangle,
  BarChart3,
  Eye,
  KeyRound,
  ListChecks,
  LogOut,
  UserCog,
  Clock3,
  Database,
  Download,
  Flag,
  LayoutDashboard,
  Menu,
  Moon,
  Newspaper,
  Archive,
  Trash2,
  Plus,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trophy,
  Sun,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useTheme } from "@/contexts/ThemeContext";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ProposedFeatureWorkspace } from "@/components/ProposedFeatureWorkspace";
import { MatchDetailsDrawer } from "@/components/MatchDetailsDrawer";
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import {
  authenticateUser,
  calculateStandings,
  createSeedDatabase,
  DEFAULT_TIEBREAKERS,
  canConfirmMatch,
  canSubmitMatch,
  calculateTeamPerformance,
  formatMatchKickoff,
  isMatchDateOpen,
  countConfirmed,
  countPending,
  formatMatchDate,
  leagueDateKey,
  currentUser as getCurrentUser,
  getDatabase,
  leaderboard,
  livePlayerStats,
  ruleLabel,
  makeId,
  matchLabel,
  saveDatabase,
  teamById,
  type Activity as LeagueActivity,
  type ChronicleBentoHighlight,
  type ChronicleEditorial,
  type ChroniclePrediction,
  type ChronicleUpcomingFixtureFact,
  type Goal,
  type LeagueDatabase,
  type LeagueNewsStory,
  type PunditEditorial,
  type Match,
  type SeasonArchive,
  type PlayerStat,
  type Standing,
  type Team,
  type TeamPerformance,
  type TiebreakerRule,
  type UserAccount,
} from "@/lib/league-db";
import { backendAnalyzeScorerReviews, backendApproveScorerReview, backendApproveTeam, backendCompleteSeason, backendConfirmResult, backendCreatePundit, backendCreateSeason, backendCreateTeam, backendDashboard, backendDeletePundit, backendDeleteTeam, backendDownloadDatabaseExport, backendEnabled, backendGetNextFixtureNotifications, backendGetPlayers, backendLogin, backendLogout, backendMe, backendRefreshNews, backendRegister, backendRejectScorerReview, backendRenamePlayer, backendRescheduleMatch, backendResetTournament, backendScorerSuggestions, backendSendNextFixtureNotifications, backendStartTournament, backendSubmitResult, backendUpdateTeam, backendUpdateUser, mergeBackendDashboard, toLocalUser, type BackendNextFixtureNotification, type BackendNextFixtureNotificationsResponse, type BackendPlayerRegistryEntry, type BackendScorerReview } from "@/lib/backend-api";

type View = "overview" | "fixtures" | "teams" | "table" | "chronicle" | "database" | "rules" | "league-tools";
type ResultInput = { id: string; teamId: string; playerName: string; playerEmail?: string; minute: string };
type RescheduleHandler = (matchId: string) => void;

function initials(value: string) {
  return value.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function statusLabel(status: Match["status"]) {
  if (status === "CONFIRMED") return "Official result";
  if (status === "PENDING") return "Pending confirmation";
  if (status === "DISPUTED") return "Needs review";
  if (status === "POSTPONED") return "Postponed";
  return "Not played yet";
}

function statusClass(status: Match["status"]) {
  return status.toLowerCase();
}

function shortDay(date: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(new Date(`${date}T12:00:00`));
}

function dateKey(date = new Date()) {
  return leagueDateKey(date);
}

function isUserFixture(match: Match, user: UserAccount) {
  return Boolean(user.teamId && (match.homeTeamId === user.teamId || match.awayTeamId === user.teamId));
}

function fixtureStateCopy(match: Match) {
  if (match.status === "PENDING") return "Result submitted · awaiting admin confirmation";
  if (match.status === "SCHEDULED") return isMatchDateOpen(match) ? "Ready for the home team" : `Opens ${formatMatchDate(match.date)}`;
  if (match.status === "POSTPONED") return "New date required";
  if (match.status === "DISPUTED") return "Needs admin review";
  return match.goals.length ? `${match.goals.length} goal${match.goals.length === 1 ? "" : "s"} logged` : "Official result";
}

function TeamMark({ team, size = "md" }: { team?: Team; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`team-mark team-mark-${size}`} style={{ "--team-accent": team?.accent ?? "#b2b9bc" } as CSSProperties}>
      {team ? initials(team.name) : "??"}
    </span>
  );
}

function MetricCard({ label, value, note, accent, icon: Icon }: { label: string; value: string; note: string; accent: string; icon: typeof Database }) {
  return (
    <article className="metric-card" style={{ "--metric-accent": accent } as CSSProperties}>
      <div className="metric-card-top"><span className="metric-card-label">{label}</span><Icon size={17} strokeWidth={1.8} /></div>
      <strong>{value}</strong>
      <span className="metric-card-note">{note}</span>
    </article>
  );
}

function FormPill({ value }: { value: "W" | "D" | "L" }) {
  return <span className={`form-pill form-${value.toLowerCase()}`}>{value}</span>;
}

function MatchRow({ database, match, user, isAdmin, onResult, onConfirm, onReschedule, onDetails }: { database: LeagueDatabase; match: Match; user: UserAccount; isAdmin: boolean; onResult: (id: string) => void; onConfirm: (id: string) => void; onReschedule: RescheduleHandler; onDetails?: (id: string) => void }) {
  const home = teamById(database.teams, match.homeTeamId);
  const away = teamById(database.teams, match.awayTeamId);
  const owned = isUserFixture(match, user);
  const settled = match.status === "CONFIRMED" && match.homeScore !== null && match.awayScore !== null;
  const homeWon = settled && match.homeScore! > match.awayScore!;
  const awayWon = settled && match.awayScore! > match.homeScore!;
  const outcomeLabel = settled ? (homeWon ? "HOME WIN" : awayWon ? "AWAY WIN" : "DRAW") : null;
  const scorerSummary = match.goals.map((goal) => `${teamById(database.teams, goal.teamId)?.shortName ?? "TEAM"} · ${goal.playerName} ${goal.minute}'`).join(" / ");
  const canConfirm = isAdmin && match.status === "PENDING";
  const dateOpen = isMatchDateOpen(match);
  const canEnter = canSubmitMatch(user, match);
  return (
    <article className={`match-row ${owned ? "match-row-owned" : ""} ${settled ? "match-row-settled" : ""}`}>
      <div className="match-date"><span>{shortDay(match.date)}</span><strong>{formatMatchDate(match.date)}</strong><small>{formatMatchKickoff(match)} · Matchday {match.matchday}</small></div>
      <div className="match-teams">
        <div className={`match-team home ${homeWon ? "match-team-winner" : ""}`}><span>{home?.name}</span>{homeWon && <b className="winner-tag">WINNER</b>}<TeamMark team={home} size="sm" /></div>
        <div className={`match-score ${outcomeLabel ? "match-score-settled" : ""}`}>
          {match.homeScore === null ? <><span className="vs">VS</span><small>Not played</small></> : <><strong>{match.homeScore} <i>–</i> {match.awayScore}</strong><small>{match.status === "PENDING" ? "Provisional score" : "Full time"}</small>{outcomeLabel && <span className={`match-outcome-badge ${homeWon || awayWon ? "win" : "draw"}`}>{outcomeLabel}</span>}</>}
        </div>
        <div className={`match-team away ${awayWon ? "match-team-winner" : ""}`}><TeamMark team={away} size="sm" />{awayWon && <b className="winner-tag">WINNER</b>}<span>{away?.name}</span></div>
      </div>
      <div className="match-meta"><span className={`match-ownership ${owned ? "owned" : "neutral"}`}>{owned ? "Your fixture" : "League fixture"}</span><span className={`status-chip ${statusClass(match.status)}`}><span />{statusLabel(match.status)}</span><small>{match.status === "CONFIRMED" && match.goals.length ? `${match.goals.length} goal${match.goals.length === 1 ? "" : "s"} logged` : fixtureStateCopy(match)}</small>{match.goals.length > 0 && match.status !== "SCHEDULED" && <div className={`match-goals-summary ${match.status === "CONFIRMED" ? "official" : "provisional"}`}><strong>{match.status === "CONFIRMED" ? "GOALS" : "PROVISIONAL GOALS"}</strong><span>{scorerSummary}</span></div>}</div>
      <div className="match-actions">
        {onDetails && <button className="row-action row-action-secondary" onClick={() => onDetails(match.id)} aria-label={`Open details for ${home?.name || "home"} versus ${away?.name || "away"}`}>Details <ChevronRight size={14} /></button>}
        {canConfirm && <button className="confirm-link" onClick={() => onConfirm(match.id)}><Check size={14} /> Confirm</button>}
        {isAdmin && match.status !== "CONFIRMED" && <button className="row-action row-action-secondary" onClick={() => onReschedule(match.id)}>{match.status === "POSTPONED" ? "Adjust date" : "Postpone"}</button>}
        {canEnter ? <button className="row-action" onClick={() => onResult(match.id)}>{match.status === "SCHEDULED" || match.status === "POSTPONED" ? "Enter result" : "View result"}<ArrowRight size={14} /></button> : <span className="match-locked"><Clock3 size={13} />{match.status === "CONFIRMED" ? "Official" : dateOpen ? "Home team only" : `Opens ${formatMatchDate(match.date)}`}</span>}
      </div>
    </article>
  );
}

function StandingTable({ standings, compact = false }: { standings: Standing[]; compact?: boolean }) {
  const rows = compact ? standings.slice(0, 5) : standings;
  return (
    <div className="table-wrap">
      <div className="table-scroll-cue" role="note"><span>Swipe for more standings data</span><ArrowRight size={13} /></div>
      <table className="standing-table">
        <thead><tr><th className="rank-col">#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th className="points-col">Pts</th></tr></thead>
        <tbody>
          {rows.map((team, index) => (
            <tr key={team.id}>
              <td className="rank-col"><span className={`rank-number ${index === 0 ? "leader" : ""}`}>{index + 1}</span></td>
              <td><div className="standing-team"><TeamMark team={team} size="sm" /><span>{team.name}</span></div></td>
              <td>{team.played}</td><td>{team.won}</td><td>{team.drawn}</td><td>{team.lost}</td><td className={team.goalDifference > 0 ? "positive-number" : ""}>{team.goalDifference > 0 ? "+" : ""}{team.goalDifference}</td><td className="points-col"><strong>{team.points}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="standing-mobile-list" aria-label="Mobile standings cards">{rows.map((team, index) => <article className="standing-mobile-card" key={`mobile-${team.id}`}><div className="standing-mobile-main"><span className={`rank-number ${index === 0 ? "leader" : ""}`}>{index + 1}</span><TeamMark team={team} size="sm" /><strong>{team.name}</strong><b>{team.points} pts</b></div><div className="standing-mobile-stats"><span><b>{team.played}</b><small>P</small></span><span><b>{team.won}</b><small>W</small></span><span><b>{team.drawn}</b><small>D</small></span><span><b>{team.lost}</b><small>L</small></span><span><b className={team.goalDifference > 0 ? "positive-number" : ""}>{team.goalDifference > 0 ? "+" : ""}{team.goalDifference}</b><small>GD</small></span></div></article>)}</div>
      {compact && <p className="table-footnote">Live table · sorted by points, goal difference, then goals scored <ArrowRight size={14} /></p>}
    </div>
  );
}

function ActivityFeed({ activities, news }: { activities: LeagueActivity[]; news: LeagueNewsStory[] }) {
  if (news.length) return <div className="activity-feed">{news.slice(0, 4).map((story) => <article className="activity-item activity-news" key={story.id}><span className="activity-icon"><Newspaper size={15} /></span><div><strong>{story.headline}</strong><p>{story.description}</p></div><time>{story.storyDate}</time></article>)}</div>;
  return <div className="activity-feed"><p className="muted-copy">No AI news yet. Confirmed results and upcoming fixtures will become newsroom stories after the daily refresh.</p>{activities.map((activity) => <article className="activity-item" key={activity.id}><span className={`activity-icon activity-${activity.kind}`}>{activity.kind === "result" ? <ClipboardList size={15} /> : activity.kind === "leaderboard" ? <Trophy size={15} /> : <Sparkles size={15} />}</span><div><strong>{activity.title}</strong><p>{activity.detail}</p></div><time>{activity.time}</time></article>)}</div>;
}

function newsTable(story: LeagueNewsStory) {
  const columns = Array.isArray(story.data?.columns) ? story.data.columns.map(String) : [];
  const rows = Array.isArray(story.data?.rows) ? story.data.rows.filter((row): row is unknown[] => Array.isArray(row)) : [];
  return columns.length && rows.length ? { columns, rows } : null;
}

function NewsroomPanel({ news, archives, isAdmin, seasonStatus, seasonReady, onRefresh, onArchive, onCreateSeason, busy }: { news: LeagueNewsStory[]; archives: SeasonArchive[]; isAdmin: boolean; seasonStatus: string; seasonReady: boolean; onRefresh: () => void; onArchive: () => void; onCreateSeason: () => void; busy: boolean }) {
  const stories = news.slice(0, 8);
  return <section className="panel newsroom-panel"><div className="panel-header"><div><p className="eyebrow">eLEAGUE NEWSROOM</p><h2>Stories from the touchline</h2><p className="section-caption">AI-written reports use confirmed results, verified tables, and scheduled fixtures only. No unsupported events are added.</p></div><Newspaper size={18} className="panel-icon" /></div>{isAdmin && <div className="newsroom-actions"><Button onClick={onRefresh} disabled={busy}><RefreshCw size={14} /> {busy ? "Updating…" : "Refresh newsroom"}</Button><Button variant="outline" onClick={onArchive} disabled={busy || !seasonStatus || !seasonReady} title={!seasonReady ? "Confirm every fixture before archiving the season" : "Preserve this season and publish its summary"}><Archive size={14} /> {seasonReady ? "Archive season" : "Archive after final result"}</Button>{seasonStatus === "COMPLETED" && <Button variant="outline" onClick={onCreateSeason} disabled={busy}><Plus size={14} /> Create next season</Button>}</div>}<div className="news-story-list">{!stories.length && <div className="news-empty"><Newspaper size={22} /><strong>The newsroom is waiting for its first confirmed story.</strong><span>Daily matchday reports will appear here once the schedule and results provide evidence.</span></div>}{stories.map((story) => { const table = newsTable(story); return <article className="news-story-card" key={story.id}><div className="news-story-meta"><span className={`news-story-type news-${story.storyType.toLowerCase()}`}>{story.storyType.replaceAll("_", " ")}</span><time>{story.storyDate}</time></div><h3>{story.headline}</h3><p>{story.description}</p>{table && <div className="news-data-table"><div className="table-scroll-cue" role="note"><span>Swipe for more story data</span><ArrowRight size={13} /></div><table><thead><tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{table.rows.slice(0, 6).map((row, index) => <tr key={`${story.id}-${index}`}>{table.columns.map((_, columnIndex) => <td key={`${story.id}-${index}-${columnIndex}`}>{String(row[columnIndex] ?? "—")}</td>)}</tr>)}</tbody></table><div className="news-mobile-cards" aria-label="Mobile story data">{table.rows.slice(0, 6).map((row, rowIndex) => <article className="news-mobile-card" key={`${story.id}-mobile-${rowIndex}`}>{table.columns.map((column, columnIndex) => <div key={`${story.id}-mobile-${rowIndex}-${columnIndex}`}><small>{column}</small><strong>{String(row[columnIndex] ?? "—")}</strong></div>)}</article>)}</div></div>}<small className="news-story-source">Evidence date: {story.storyDate} · {story.model === "evidence-only-fallback" ? "Verified data fallback" : "Hugging Face editorial draft"}</small></article>; })}</div>{archives.length > 0 && <div className="season-archive-block"><div className="section-subheading"><div><p className="eyebrow">SEASON ARCHIVE</p><h3>Previous campaigns, preserved</h3></div><Archive size={17} /></div><div className="season-archive-list">{archives.slice(0, 5).map((archive) => <article className="season-archive-card" key={archive.id}><div><strong>{archive.seasonName}</strong><small>Completed {archive.completedAt.slice(0, 10)}</small></div><div className="archive-stat"><b>{archive.standings[0]?.name ? String(archive.standings[0].name) : "—"}</b><small>champion / table leader</small></div><div className="archive-stat"><b>{archive.playerStats[0]?.name ? String(archive.playerStats[0].name) : "—"}</b><small>top scorer</small></div></article>)}</div></div>}</section>;
}

const CHRONICLE_IMAGE_PRESETS: Record<string, string> = {
  "goal-celebration": "goal-celebration.jpg",
  "goalkeeper-save": "goalkeeper-save.jpg",
  "football-heritage-captains": "football-heritage-captains.jpg",
  "league-hero": "league-hero.jpg",
  "player-registry-portrait": "player-registry-portrait.jpg",
};

const CHRONICLE_TEMPLATE_BODY = "Del Piero is a One-Man Army: Alessandro Del Piero has buried 10 goals in just 4 matchdays for Soham FC. Manager Soham_2003 is completely relying on him to maintain their spot at the top of the table with 10 points.\n\nMbappé's Five-Star Carnage: Real Tamo did not just beat Barcelona on Matchday 3; they obliterated them 8-0. Kylian Mbappé was responsible for five of those goals (3', 32', 47', 55', 90').\n\nManagers on the Pitch: DXBJIT_ secured a 3-0 victory against Barcelona on Matchday 4. In a bizarre twist, Pep Guardiola scored their opening goal in the 26th minute under manager Debjit Deb Barman.\n\nBarcelona's Complete Implosion: Manager Subhankar Chakrabarti started strong with a 3-0 win, but Barcelona has since suffered three straight defeats. They have conceded 11 goals in their last two matches without scoring a single reply.\n\nChutpaglu is Free-Falling: Manager Bankai is having a nightmare; Chutpaglu has lost all four matches, yielding 17 goals and scoring only 3.\n\nThe Unbreakable Blue Horse: Manager Neelkantha Saha has turned Blue Horse of India into a tactical wall. After an opening win, they have ground out three consecutive draws to remain unbeaten.\n\nThe Zlatan Paradox: Zlatan Ibrahimović is somehow terrorizing the league for multiple teams simultaneously. He scored a hat-trick for Binod 11 against Chutpaglu and also netted a first-minute goal for PrALaY FC against Blue Horse of India.\n\nBinod 11's Whiplash Form: Binod 11 battered Chutpaglu 8-1 on Matchday 3, only to be dismantled 4-0 by Soham FC in their very next match.\n\nThe Dutch Renaissance: Blue Horse of India is being carried by classic Dutch firepower. Marco van Basten scored a brace in Matchday 4, and Ruud Gullit has also found the net to keep their undefeated streak alive.\n\nThe Invincibles: As we head into Matchday 5, four teams have yet to taste defeat: Soham FC, DXBJIT_, Real Tamo, and Blue Horse of India.\n\nPredictions & News: Matchday 6 features Real Tamo against Soham FC. Barcelona must lock down its defence, while Chutpaglu needs a defensive overhaul after a -14 goal difference.";

function chronicleImage(imageKey: string) {
  return `/assets/football/${CHRONICLE_IMAGE_PRESETS[imageKey] || CHRONICLE_IMAGE_PRESETS["goal-celebration"]}`;
}

const CHRONICLE_TEMPLATE_EDITORIAL: ChronicleEditorial = {
  edition: "ISSUE 05 • VOL. 1",
  dateline: "KHALPAR DESK — 19 AUGUST 2026",
  leadStory: {
    tag: "MATCHDAY 4 CHRONICLE",
    kicker: "PLAYER IN FOCUS",
    headline: "DEL PIERO’S DECADE: THE SOHAM FC CARRIAGE JOB",
    subdeck: "Ten goals in four outings. An unblemished record. Alessandro Del Piero isn't just leading Soham FC; he is running the entire league as his personal playground.",
    leadParagraph: "KHALPAR — While tacticians across the division tinker with high-press systems and manager-player cameos, Soham_2003's blueprint remains ruthlessly singular: get the ball to Alessandro Del Piero and get out of the way.",
    bodyParagraphs: [
      "The Italian marksman produced another clinic on Matchday 4, netting a ruthless hat-trick (9', 32', 64') alongside Juliano Belletti's 22nd-minute strike to demolish Binod 11 4-0 on their own turf.",
      "With 10 goals in just 360 minutes of football, Del Piero accounts for over 83% of Soham FC's league-leading 12-goal tally. With 10 points secured from a possible 12, they enter Matchday 5 sitting on the throne—unbeaten, untamed, and daring the rest of the division to find an answer.",
    ],
    statHighlight: { value: "10", metric: "10", label: "GOALS IN 4 MATCHES (2.5 G/G)" },
    body: "KHALPAR — While tacticians across the division tinker with high-press systems and manager-player cameos, Soham_2003's blueprint remains ruthlessly singular: get the ball to Alessandro Del Piero and get out of the way.\n\nThe Italian marksman produced another clinic on Matchday 4, netting a ruthless hat-trick (9', 32', 64') alongside Juliano Belletti's 22nd-minute strike to demolish Binod 11 4-0 on their own turf.\n\nWith 10 goals in just 360 minutes of football, Del Piero accounts for over 83% of Soham FC's league-leading 12-goal tally. With 10 points secured from a possible 12, they enter Matchday 5 sitting on the throne—unbeaten, untamed, and daring the rest of the division to find an answer.",
    accentColor: "#8B1E3F",
  },
  bentoHighlights: [
    { type: "MASSACRE", tag: "MASSACRE", title: "Mbappé’s Five-Star Demolition", detail: "Kylian Mbappé delivered the individual performance of the season, putting five past a shell-shocked Barcelona (3', 32', 47', 55', 90') in an unprecedented blowout.", scoreline: { home: "Real Tamo", homeScore: 8, away: "Barcelona", awayScore: 0, timeline: [{ player: "Mbappé", minute: "3'" }, { player: "Mbappé", minute: "32'" }, { player: "Mbappé", minute: "47'" }, { player: "Mbappé", minute: "55'" }, { player: "Mbappé", minute: "90'" }] }, accentColor: "#8B1E3F" },
    { type: "TACTICAL_ODDITY", tag: "TACTICAL ODDITY", title: "The Zlatan Paradox", detail: "Zlatan Ibrahimović terrorized defenses on two separate fronts this matchweek: bagging a clinical hat-trick for Binod 11 before striking in the 1st minute for PrALaY FC.", accentColor: "#D97706" },
    { type: "BENCH_CAMEO", tag: "BENCH CAMEO", title: "Guardiola Takes Matters Into Own Hands", detail: "Tired of mere touchline instructions, Pep Guardiola laced up for DXBJIT_, slotting home the opener in the 26th minute to sink Barcelona's battered defense.", quote: "The manager found the net. The league found a new storyline.", accentColor: "#2563EB" },
  ],
  crisisWatch: { team: "Chutpaglu", status: "FREE-FALL", badge: "FREE-FALL", statSummary: "0 PTS • -14 GD • 17 CONCEDED", stats: { played: 4, points: 0, gd: -14, goalsAgainst: 17, goalsAgainstPerGame: 4.25, cleanSheets: 0 }, verdict: "Manager Bankai faces a systemic catastrophe. Conceding 4.25 goals per game with zero clean sheets, the backline has collapsed entirely." },
  managerPressure: [
    { manager: "Bankai", team: "Chutpaglu", label: "UNDER FIRE", score: 98, note: "A winless start, 17 conceded, and no clean sheets leaves no room for another soft opening." },
    { manager: "Subhankar Chakrabarti", team: "Barcelona", label: "STRUCTURAL CRISIS", score: 88, note: "The opening win has been swallowed by an 11-goal defensive collapse across the last two matches." },
    { manager: "Soham_2003", team: "Soham FC", label: "CRUISING", score: 14, note: "Ten points, four unbeaten outings, and a forward who refuses to stop scoring." },
  ],
  awards: [
    { kind: "TEAM_OF_WEEK", label: "TEAM OF THE WEEK", name: "Soham FC", team: "Soham FC", detail: "Four matches unbeaten and top of the table on 10 points." },
    { kind: "FLOP_OF_WEEK", label: "FLOP OF THE WEEK", name: "Barcelona backline", team: "Barcelona", detail: "Eleven goals conceded across two matches without a reply." },
    { kind: "PLAYER_OF_WEEK", label: "PLAYER OF THE WEEK", name: "Alessandro Del Piero", team: "Soham FC", detail: "Ten goals in four matches, accounting for over 83% of Soham FC's league-leading tally." },
  ],
  quoteOfMatchday: { quote: "The table has stopped being polite. Del Piero has made it personal.", attribution: "THE KHALPAR CHRONICLE DESK" },
  touchlineDispatches: [
    { tag: "TACTICAL REVIEW", title: "The Dutch Wall: Neelkantha's Stalemate Strategy", blurb: "Blue Horse of India has turned the pitch into quicksand. With Marco van Basten and Ruud Gullit carrying the attack, they have ground out three consecutive draws to remain the league's toughest nut to crack." },
    { tag: "HOT SEAT ALERT", title: "Subhankar Chakrabarti in Crisis", blurb: "After an opening 3-0 win, Barcelona has imploded. Conceding 11 unanswered goals across their last 180 minutes, the manager needs immediate structural intervention ahead of Matchday 5." },
  ],
};

function structuredEditorialFromForm(headline: string, dek: string, body: string, facts: string[], standings: Standing[], useTemplate: boolean): ChronicleEditorial {
  const redZone = [...standings].sort((a, b) => a.points - b.points || a.goalDifference - b.goalDifference)[0];
  if (useTemplate) return { ...CHRONICLE_TEMPLATE_EDITORIAL, edition: `ISSUE ${String(Math.max(1, standings.reduce((max, team) => Math.max(max, team.played), 0) + 1)).padStart(2, "0")} • VOL. 1` };
  const paragraphs = body.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const statMatch = body.match(/(\d+)\s+goals?.{0,40}?(?:in|across)\s+(\d+)\s+(?:matchdays?|matches?)/i);
  const bentoHighlights: ChronicleBentoHighlight[] = facts.slice(0, 6).map((fact, index) => {
    const lower = fact.toLowerCase();
    const isBlowout = /\b\d+\s*[–-]\s*\d+\b/.test(fact);
    const isQuirk = lower.includes("zlatan") || lower.includes("multiple teams");
    const isMeme = lower.includes("pep") || lower.includes("guardiola") || lower.includes("manager") && lower.includes("goal");
    const score = fact.match(/(.+?)\s+(\d+)\s*[–-]\s*(\d+)\s+(.+)/);
    return { type: isBlowout ? "BLOWOUT" : isQuirk ? "QUIRK" : isMeme ? "MEME" : "FACT", tag: isBlowout ? "CARNAGE" : isQuirk ? "TACTICAL ANOMALY" : isMeme ? "MANAGER ON PITCH" : "THE NUMBERS", title: fact.split(":")[0].slice(0, 100) || `Desk fact ${index + 1}`, detail: fact, quote: isMeme ? fact : undefined, scoreline: score ? { home: score[1].trim(), homeScore: Number(score[2]), awayScore: Number(score[3]), away: score[4].replace(/\.$/, "").trim() } : undefined, accentColor: isBlowout ? "#8B1E3F" : isQuirk ? "#C48A2A" : isMeme ? "#294C60" : "#8B1E3F" };
  });
  return { edition: `ISSUE ${String(Math.max(1, standings.reduce((max, team) => Math.max(max, team.played), 0) + 1)).padStart(2, "0")} • VOL. 1`, dateline: `KHALPAR DESK — ${dateKey()}`, leadStory: { tag: "LEAD STORY", kicker: "THE PUNDIT DESK", headline, subdeck: dek, leadParagraph: paragraphs[0] || dek, bodyParagraphs: paragraphs.slice(1, 4), statHighlight: statMatch ? { value: statMatch[1], label: `${statMatch[2]} MATCHDAYS` } : undefined, body: paragraphs.slice(0, 4).join("\n\n"), accentColor: "#8B1E3F" }, bentoHighlights, crisisWatch: redZone ? { team: redZone.name, status: redZone.points === 0 ? "FREE-FALL" : "PRESSURE", stats: { played: redZone.played, points: redZone.points, gd: redZone.goalDifference }, verdict: `${redZone.name} sits on ${redZone.points} points with a ${redZone.goalDifference > 0 ? "+" : ""}${redZone.goalDifference} goal difference.` } : undefined, managerPressure: redZone ? [{ manager: redZone.manager, team: redZone.name, label: redZone.points === 0 ? "UNDER FIRE" : "UNDER REVIEW", score: Math.max(8, Math.min(98, 70 - redZone.points * 5 + Math.max(0, -redZone.goalDifference) * 2)), note: `${redZone.name} sits on ${redZone.points} points with a ${redZone.goalDifference > 0 ? "+" : ""}${redZone.goalDifference} goal difference.` }] : [], awards: [], touchlineDispatches: [] };
}

async function copyChronicleSnippet(text: string) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else { const area = document.createElement("textarea"); area.value = text; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove(); }
    toast.success("Card copied", { description: "The formatted Chronicle snippet is ready to paste." });
  } catch { toast.error("Could not copy card", { description: "Select the text manually and try again." }); }
}

function ChronicleScoreline({ scoreline }: { scoreline: NonNullable<ChronicleBentoHighlight["scoreline"]> }) {
  return <div className="chronicle-scoreline"><div><span>{initials(scoreline.home)}</span><strong>{scoreline.home}</strong></div><b>{scoreline.homeScore}</b><em>—</em><b>{scoreline.awayScore}</b><div><span>{initials(scoreline.away)}</span><strong>{scoreline.away}</strong></div>{scoreline.timeline?.length ? <div className="chronicle-score-timeline" aria-label="Scoring timeline"><span>0′</span><div className="chronicle-timeline-track">{scoreline.timeline.map((event, index) => <i key={`${event.player}-${event.minute}-${index}`} title={`${event.minute} ${event.player}`} style={{ left: `${Math.min(96, Math.max(4, Number.parseInt(event.minute, 10) || (index + 1) * 18))}%` }}><b /></i>)}</div><span>90′</span></div> : null}</div>;
}

function ChronicleSecondaryDesk({ editorial }: { editorial?: ChronicleEditorial }) {
  const pressure = editorial?.managerPressure || [];
  const awards = editorial?.awards || [];
  const dispatches = editorial?.touchlineDispatches || [];
  return <>
    {(pressure.length || awards.length) ? <div className="chronicle-secondary-grid">
      {pressure.length ? <section className="chronicle-pressure-panel"><div className="chronicle-section-heading"><div><p className="chronicle-overline">03 / HOT SEAT</p><h4>Manager Pressure Index</h4></div><span>Heat, not hype</span></div><div className="chronicle-pressure-list">{pressure.map((item) => <article key={`${item.manager}-${item.team}`}><div className="pressure-row"><strong>{item.manager}</strong><span>{item.team}</span><b>{item.label}</b></div><div className="pressure-meter"><span style={{ width: `${item.score}%` }} /></div><p>{item.note}</p></article>)}</div></section> : null}
      {awards.length ? <section className="chronicle-award-panel"><div className="chronicle-section-heading"><div><p className="chronicle-overline">04 / WEEKLY FILE</p><h4>Team & Flop of the Week</h4></div><span>Filed by the desk</span></div><div className="chronicle-award-list">{awards.map((award) => <article className={`chronicle-award-card award-${award.kind.toLowerCase().replaceAll("_", "-")}`} key={`${award.kind}-${award.name}`}><div><span>{award.label}</span><strong>{award.name}</strong>{award.team && <small>{award.team}</small>}</div><p>{award.detail}</p></article>)}</div></section> : null}
    </div> : null}
    {editorial?.quoteOfMatchday?.quote ? <blockquote className="chronicle-quote-box"><Quote size={22} /><div><p>QUOTE OF THE MATCHDAY</p><strong>“{editorial.quoteOfMatchday.quote}”</strong>{editorial.quoteOfMatchday.attribution && <span>— {editorial.quoteOfMatchday.attribution}</span>}</div></blockquote> : null}
    {dispatches.length ? <section className="chronicle-dispatches"><div className="chronicle-section-heading"><div><p className="chronicle-overline">05 / TOUCHLINE DISPATCHES</p><h4>What the table is not saying</h4></div><span>Reports from the edge</span></div><div className="chronicle-dispatch-grid">{dispatches.map((dispatch) => <article key={dispatch.title}><span>{dispatch.tag}</span><h5>{dispatch.title}</h5><p>{dispatch.blurb}</p></article>)}</div></section> : null}
  </>;
}

function ChroniclePredictionDesk({ editorial }: { editorial?: ChronicleEditorial }) {
  const predictions: ChroniclePrediction[] = editorial?.predictions || [];
  const fixtureFacts: ChronicleUpcomingFixtureFact[] = editorial?.upcomingFixtureFacts || [];
  if (!predictions.length && !fixtureFacts.length) return null;
  return <section className="chronicle-prediction-desk">
    <div className="chronicle-section-heading"><div><p className="chronicle-overline">06 / THE FORECAST</p><h4>Next fixtures, read by the data</h4></div><span>Prediction, not result</span></div>
    <div className="chronicle-prediction-grid">
      {predictions.map((prediction) => <article className="chronicle-prediction-card" key={`${prediction.matchday}-${prediction.fixture}`}><div className="prediction-card-top"><span>MD {String(prediction.matchday).padStart(2, "0")} · {prediction.date}</span><b className={`prediction-confidence confidence-${prediction.confidence.toLowerCase()}`}>{prediction.confidence} SIGNAL</b></div><h5>{prediction.fixture}</h5><div className="prediction-pick"><span>DATA DESK PICK</span><strong>{prediction.pick}</strong></div><p>{prediction.rationale}</p><small>Calculated from confirmed standings and team performance only.</small></article>)}
    </div>
    {fixtureFacts.length ? <div className="chronicle-upcoming-facts"><div className="chronicle-section-heading"><div><p className="chronicle-overline">07 / FIXTURE FILES</p><h4>What the next days are telling us</h4></div><span>Verified before publication</span></div><div className="chronicle-upcoming-facts-grid">{fixtureFacts.map((item) => <article key={`${item.matchday}-${item.fixture}`}><div className="upcoming-fact-meta"><span>MD {String(item.matchday).padStart(2, "0")}</span><time>{item.date}</time></div><h5>{item.fixture}</h5><ul>{item.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul></article>)}</div></div> : null}
  </section>;
}

function KhalparChroniclePanel({ editorials, standings, isAdmin, seasonId, busy, onPublish, onDelete }: { editorials: PunditEditorial[]; standings: Standing[]; isAdmin: boolean; seasonId: number | null; busy: boolean; onPublish: (input: { seasonId: number | null; publishDate: string; section: string; headline: string; dek: string; body: string; imageKey: string; facts: string[]; editorial?: ChronicleEditorial }) => void; onDelete: (id: string) => void }) {
  const hero = editorials[0];
  const [headline, setHeadline] = useState("DEL PIERO'S DECADE");
  const [dek, setDek] = useState("10 goals in 4 matchdays: Soham FC's one-man empire.");
  const [body, setBody] = useState(CHRONICLE_TEMPLATE_BODY);
  const [imageKey, setImageKey] = useState("goal-celebration");
  const [publishDate, setPublishDate] = useState(dateKey());
  const [factsText, setFactsText] = useState("Del Piero's 10 goals in four matchdays for Soham FC.\nMbappé scored five in Real Tamo's 8-0 win over Barcelona.\nFour teams entered Matchday 5 unbeaten.");
  const redZone = [...standings].sort((a, b) => a.points - b.points || a.goalDifference - b.goalDifference)[0];
  const currentMatchday = standings.reduce((max, team) => Math.max(max, team.played), 0) + 1;
  const useTemplate = headline === "DEL PIERO'S DECADE" && dek === "10 goals in 4 matchdays: Soham FC's one-man empire." && body === CHRONICLE_TEMPLATE_BODY;
  const editorial = hero?.editorial || (hero ? structuredEditorialFromForm(hero.headline, hero.dek, hero.body, hero.facts, standings, false) : undefined);
  const lead = editorial?.leadStory || (hero ? { tag: "LEAD STORY", headline: hero.headline, subdeck: hero.dek, body: hero.body, accentColor: "#8B1E3F" } : null);
  const crisis = editorial?.crisisWatch || (redZone ? { team: redZone.name, status: redZone.points === 0 ? "FREE-FALL" : "PRESSURE", stats: { played: redZone.played, points: redZone.points, gd: redZone.goalDifference }, verdict: `${redZone.name} sits on ${redZone.points} points with a ${redZone.goalDifference > 0 ? "+" : ""}${redZone.goalDifference} goal difference.` } : undefined);
  function submit(event: FormEvent) {
    event.preventDefault();
    const facts = factsText.split("\n").map((fact) => fact.trim()).filter(Boolean).slice(0, 6);
    if (!headline.trim() || !dek.trim() || body.trim().length < 40) { toast.error("Complete the Chronicle headline, standfirst, and copy."); return; }
    const structured = structuredEditorialFromForm(headline.trim(), dek.trim(), body.trim(), facts, standings, useTemplate);
    onPublish({ seasonId, publishDate, section: "THE PUNDIT DESK", headline: headline.trim(), dek: dek.trim(), body: body.trim(), imageKey, facts, editorial: structured });
  }
  return <section className="panel chronicle-panel">
    <div className="chronicle-masthead"><div><p className="chronicle-kicker">THE PULSE OF LEAGUE'DE KHALPAR</p><h2>THE KHALPAR CHRONICLE</h2><span className="chronicle-edition">{editorial?.edition || `Matchday ${currentMatchday} Special`}</span></div><div className="chronicle-date"><strong>{editorial?.dateline || new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${(hero?.publishDate || dateKey())}T12:00:00`))}</strong><span>Matchday {currentMatchday} · {hero?.section || "Pundit desk"}</span></div></div>
    <div className="chronicle-rule" />
    {!hero ? <div className="chronicle-empty"><Newspaper size={22} /><div><strong>The Chronicle is waiting for its inaugural issue.</strong><p>Use the admin desk below to publish a signed editorial. The league data room remains separate and evidence-backed.</p></div></div> : <>
      <div className="chronicle-lead-grid"><article className="chronicle-hero-story"><div className="chronicle-image-wrap"><img src={chronicleImage(hero.imageKey)} alt="Editorial football moment" /><span>{lead?.tag || hero.section}</span>{lead?.statHighlight && <div className="chronicle-stat-chip"><strong>{lead.statHighlight.value}</strong><span>{lead.statHighlight.label}</span></div>}</div><div className="chronicle-hero-copy"><p className="chronicle-overline">{editorial?.dateline || hero.publishDate} · {lead?.kicker || lead?.tag || "SPECIAL REPORT"}</p><h3>{lead?.headline || hero.headline}</h3><p className="chronicle-dek">{lead?.subdeck || hero.dek}</p>{(lead?.leadParagraph || lead?.body) && <p className="chronicle-lead-paragraph">{lead?.leadParagraph || lead?.body.split(/\n{2,}/)[0]}</p>}<div className="chronicle-body chronicle-body-structured chronicle-body-columns">{(lead?.bodyParagraphs?.length ? lead.bodyParagraphs : (lead?.body || hero.body).split(/\n{2,}/).slice(1, 4)).map((paragraph, index) => <p className={index === 0 ? "drop-cap" : ""} key={`${hero.id}-paragraph-${index}`}>{paragraph}</p>)}</div><small>Filed by {hero.createdByEmail || "The Khalpar Chronicle desk"}</small>{isAdmin && <button className="chronicle-delete" onClick={() => onDelete(hero.id)} disabled={busy}><Trash2 size={13} /> Delete issue</button>}</div></article>
        <aside className="chronicle-chalkboard"><div className="chalkboard-heading"><span>THE CHALKBOARD</span><small>FORM & PRESSURE</small></div><h4>Top four invincibles</h4><div className="chalkboard-table">{standings.slice(0, 4).map((team, index) => <div key={team.id}><b>{String(index + 1).padStart(2, "0")}</b><span>{team.name}</span><strong>{team.points} pts</strong><small>{team.form.slice(-4).map((result, formIndex) => <i className={`form-pill form-${result.toLowerCase()}`} key={`${team.id}-${formIndex}`}>{result}</i>)}<em>{team.played} played · {team.goalDifference > 0 ? "+" : ""}{team.goalDifference} GD</em></small></div>)}</div><div className="red-zone-box"><span><AlertTriangle size={13} /> RED-ZONE WATCH</span>{crisis ? <><div className="crisis-heading"><strong>{crisis.team}</strong><b>{crisis.status}</b></div><div className="crisis-gauge"><span style={{ width: `${Math.max(12, Math.min(100, 100 - crisis.stats.points * 8 + Math.max(0, -crisis.stats.gd) * 3))}%` }} /></div><p>{crisis.verdict}</p><small>{crisis.stats.played} played · {crisis.stats.points} pts · {crisis.stats.gd > 0 ? "+" : ""}{crisis.stats.gd} GD</small></> : <p>Live standings will appear once results are confirmed.</p>}</div></aside>
      </div>
      <div className="chronicle-bento"><div className="chronicle-section-heading"><div><p className="chronicle-overline">02 / BENTO HIGHLIGHTS</p><h4>Three moments worth clipping</h4></div><span>Structured desk copy</span></div><div className="chronicle-bento-grid">{(editorial?.bentoHighlights || []).slice(0, 3).map((card, index) => { const snippet = `${card.tag}\n${card.title}\n${card.detail}${card.scoreline ? `\n${card.scoreline.home} ${card.scoreline.homeScore}–${card.scoreline.awayScore} ${card.scoreline.away}` : ""}`; return <article className={`chronicle-bento-card bento-${card.type.toLowerCase()}`} key={`${hero.id}-bento-${index}`} style={{ "--card-accent": card.accentColor || "#8B1E3F" } as CSSProperties}><div className="bento-card-head"><span>{card.tag}</span><button type="button" className="chronicle-clip" aria-label={`Copy ${card.title} to clipboard`} title="Copy this Chronicle card" onClick={() => void copyChronicleSnippet(snippet)}><Copy size={13} /> Clip</button></div><h5>{card.title}</h5>{card.scoreline ? <ChronicleScoreline scoreline={card.scoreline} /> : card.quote ? <blockquote><Quote size={16} />{card.quote}</blockquote> : <p>{card.detail}</p>} {!card.scoreline && card.quote && <p className="bento-detail">{card.detail}</p>}</article>; })}</div></div><ChroniclePredictionDesk editorial={editorial} /><ChronicleSecondaryDesk editorial={editorial} />
    </>}
    {isAdmin && <details className="chronicle-publish" open={!hero}><summary><span><Pencil size={15} /> Publish to the Chronicle</span><small>Strict editorial JSON · admin only</small></summary><form onSubmit={submit}><div className="chronicle-form-grid"><label>Headline<input value={headline} onChange={(event) => setHeadline(event.target.value)} maxLength={180} /></label><label>Standfirst / dek<input value={dek} onChange={(event) => setDek(event.target.value)} maxLength={280} /></label><label>Publish date<input type="date" value={publishDate} onChange={(event) => setPublishDate(event.target.value)} /></label><label>Preset image<select value={imageKey} onChange={(event) => setImageKey(event.target.value)}>{Object.keys(CHRONICLE_IMAGE_PRESETS).map((key) => <option value={key} key={key}>{key.replaceAll("-", " ")}</option>)}</select></label></div><label>Editorial copy<textarea value={body} onChange={(event) => setBody(event.target.value)} rows={10} /></label><label>Spicy facts <span className="form-help">One fact per line; the system maps these into lead, bento, and crisis widgets.</span><textarea value={factsText} onChange={(event) => setFactsText(event.target.value)} rows={4} /></label><div className="chronicle-form-actions"><small>Publishes to season {seasonId || "the current league"}; the backend validates and stores a strict editorial schema.</small><Button type="submit" disabled={busy}><Newspaper size={15} /> {busy ? "Publishing…" : "Publish issue"}</Button></div></form></details>}
    {editorials.length > 1 && <div className="chronicle-back-catalog"><div className="chronicle-section-heading"><div><p className="chronicle-overline">03 / BACK CATALOG</p><h4>Previous dispatches</h4></div></div>{editorials.slice(1).map((item) => <article key={item.id}><div><span>{item.publishDate}</span><strong>{item.headline}</strong><p>{item.dek}</p></div>{isAdmin && <button className="chronicle-delete" onClick={() => onDelete(item.id)} disabled={busy}><Trash2 size={13} /> Delete</button>}</article>)}</div>}
  </section>;
}

function LoginPanel({ database, onLogin, useBackend }: { database: LeagueDatabase; onLogin: (user: UserAccount) => void; useBackend: boolean }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState(useBackend ? "" : "alex@eleague.local");
  const [passcode, setPasscode] = useState(useBackend ? "" : "admin123");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const googleStatus = params.get("google");
    if (googleStatus === "error") {
      toast.error("Google sign-in failed", { description: params.get("reason") || "Please try again or use email and password." });
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  function continueWithGoogle() {
    if (!useBackend) {
      toast.error("Google sign-in is available for the live league only.");
      return;
    }
    window.location.assign("/api/auth/google");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    setBusy(true);
    try {
      if (!useBackend) {
        if (mode === "signup") throw new Error("Registration is available when the live league database is enabled.");
        const user = authenticateUser(database, email, passcode);
        if (!user) throw new Error("Check the league email and passcode, then try again.");
        onLogin(user);
        toast.success(`Welcome back, ${user.name.split(" ")[0]}`, { description: user.role === "admin" ? "Admin permissions are active." : "Player permissions are active." });
      } else if (mode === "signin") {
        const result = await backendLogin(email, passcode);
        onLogin(toLocalUser(result.user));
        toast.success(`Welcome back, ${result.user.displayName.split(" ")[0]}`, { description: result.user.role === "admin" ? "Admin permissions are active." : "Player permissions are active." });
      } else {
        const result = await backendRegister(email, passcode, displayName);
        onLogin(toLocalUser(result.user));
        toast.success("Account created", { description: result.message || "Your league administrator will assign you to a team before fixtures begin." });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Try again.";
      setFormError(message);
      toast.error(mode === "signin" ? "Sign-in failed" : "Registration failed", { description: message });
    } finally {
      setBusy(false);
    }
  }

  const signingUp = mode === "signup";
  return <div className="auth-shell"><div className="auth-card"><div className="league-brand auth-brand"><span className="brand-ball"><span /></span><div><strong>eLeague<span>.</span></strong><small>matchday manager</small></div></div><p className="eyebrow">SECURE LEAGUE ACCESS</p><div className="auth-mode-toggle"><button className={mode === "signin" ? "active" : ""} type="button" onClick={() => setMode("signin")}>Sign in</button><button className={mode === "signup" ? "active" : ""} type="button" onClick={() => setMode("signup")}>Create account</button></div><h1>{signingUp ? "Create your league account." : "Sign in to matchday."}</h1><p className="auth-copy">{signingUp ? "Create an account with your name and email. The league administrator will assign your team and permissions." : "Your role controls what you can change. Admins manage the competition; players have read-only access to league records."}</p>{!signingUp && useBackend && <><button type="button" className="google-auth-button" onClick={continueWithGoogle}><span className="google-mark">G</span><span>Continue with Google</span></button><div className="auth-divider"><span>or use email</span></div></>}<form className="auth-form" onSubmit={submit}>{signingUp && <><label>Display name <span className="field-help">Your real name, for example Tamagno Roy.</span><input autoComplete="name" required value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Tamagno Roy" /></label></>}<label>League email<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" autoComplete={signingUp ? "new-password" : "current-password"} minLength={8} required value={passcode} onChange={(event) => setPasscode(event.target.value)} /></label>{formError && <p className="auth-form-error" role="alert">{formError}</p>}<Button type="submit" disabled={busy}>{signingUp ? <Users size={16} /> : <KeyRound size={16} />} {busy ? "Saving…" : signingUp ? "Submit registration" : "Sign in"}</Button></form>{signingUp ? <div className="demo-access"><strong>What happens next</strong><span>Your account is created with a pending team assignment.</span><span>The league administrator will place you in an approved team.</span><span>League Tools and match-management actions are reserved for the administrator.</span></div> : useBackend ? <div className="demo-access"><strong>Google account linking</strong><span>Google matches the email to your existing eLeague account. Your team, role, and league records stay unchanged.</span></div> : <div className="demo-access"><strong>Demo access</strong><span>Admin · alex@eleague.local / admin123</span><span>Player · sam@eleague.local / player123</span></div>}</div></div>;
}

function PlayerStatsPanel({ stats }: { stats: PlayerStat[] }) {
  return <section className="panel stats-panel"><div className="panel-header"><div><p className="eyebrow">PLAYER INTELLIGENCE</p><h2>Form & scoring</h2></div><BarChart3 size={18} className="panel-icon" /></div>{stats.length ? <div className="player-stat-grid">{stats.slice(0, 8).map((player, index) => <article className="player-stat-card" key={`${player.teamId}-${player.playerEmail || player.name}`}><div className="player-stat-heading"><span className="scorer-rank">{String(index + 1).padStart(2, "0")}</span><div className="scorer-avatar">{initials(player.name)}</div><div><strong>{player.name}</strong><small>{player.teamName}</small></div></div><div className="player-stat-metrics"><span><b>{player.officialGoals}</b><small>official</small></span><span><b>{player.pendingGoals}</b><small>pending</small></span><span><b>{player.appearances}</b><small>matches</small></span><span><b>{player.averageMinute || "—"}</b><small>avg min</small></span></div></article>)}</div> : <Empty className="designed-empty-state"><EmptyHeader><EmptyMedia variant="icon"><BarChart3 size={20} /></EmptyMedia><EmptyTitle>No scorer data yet</EmptyTitle><EmptyDescription>Player form will appear as soon as a goal is logged.</EmptyDescription></EmptyHeader></Empty>}{stats.length > 0 && <p className="table-footnote"><Eye size={14} /> Pending goals are visible immediately but only confirmed goals count toward the official Golden Boot.</p>}</section>;
}

function TeamPerformancePanel({ performance }: { performance: TeamPerformance[] }) {
  const scoringLeaders = [...performance].sort((a, b) => b.goalsFor - a.goalsFor || b.goalsAgainst - a.goalsAgainst || a.teamName.localeCompare(b.teamName)).slice(0, 5);
  const cleanSheetLeaders = [...performance].sort((a, b) => b.cleanSheets - a.cleanSheets || a.goalsAgainst - b.goalsAgainst || a.teamName.localeCompare(b.teamName)).slice(0, 5);
  const leaderRows = (rows: TeamPerformance[], metric: "goals" | "cleanSheets") => rows.map((team, index) => <div className="performance-record-item" key={`${metric}-${team.teamId}`}><span className={`performance-rank ${index === 0 ? "leader" : ""}`}>{String(index + 1).padStart(2, "0")}</span><div className="performance-team"><span className="performance-code">{team.shortName}</span><strong>{team.teamName}</strong></div><strong className="performance-value">{metric === "goals" ? team.goalsFor : team.cleanSheets}</strong></div>);
  const chartData = performance.filter((team) => team.matchesPlayed > 0).slice(0, 6).map((team) => ({ team: team.shortName, goals: team.goalsFor, conceded: team.goalsAgainst }));
  return <section className="panel team-performance-panel"><div className="panel-header"><div><p className="eyebrow">TEAM INTELLIGENCE</p><h2>Attack & defensive record</h2><p className="section-caption">Confirmed matches only. A clean sheet means conceding zero goals in one match.</p></div><Trophy size={18} className="panel-icon" /></div>{performance.some((team) => team.matchesPlayed > 0) ? <><div className="performance-record-grid"><div className="performance-record-card"><div className="performance-record-heading"><span>Highest scoring teams</span><small>Goals for</small></div><div className="performance-record-list">{leaderRows(scoringLeaders, "goals")}</div></div><div className="performance-record-card"><div className="performance-record-heading"><span>Most clean sheets</span><small>0 goals conceded</small></div><div className="performance-record-list">{leaderRows(cleanSheetLeaders, "cleanSheets")}</div></div></div><div className="performance-chart-wrap"><div className="performance-record-heading"><span>Goals profile</span><small>For / against</small></div><ChartContainer className="performance-chart" config={{ goals: { label: "Goals for", color: "#8b1e3f" }, conceded: { label: "Goals against", color: "#c7a45a" } }}><BarChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}><CartesianGrid vertical={false} strokeDasharray="3 3" /><XAxis dataKey="team" tickLine={false} axisLine={false} tickMargin={8} /><YAxis allowDecimals={false} tickLine={false} axisLine={false} /><RechartsTooltip cursor={false} content={<ChartTooltipContent />} /><Bar dataKey="goals" fill="var(--color-goals)" radius={[4, 4, 0, 0]} /><Bar dataKey="conceded" fill="var(--color-conceded)" radius={[4, 4, 0, 0]} /></BarChart></ChartContainer></div></> : <Empty className="designed-empty-state designed-empty-wide"><EmptyHeader><EmptyMedia variant="icon"><Trophy size={20} /></EmptyMedia><EmptyTitle>Performance records are waiting</EmptyTitle><EmptyDescription>Confirm a match to populate scoring, clean-sheet, and goals-profile rankings.</EmptyDescription></EmptyHeader></Empty>}</section>;
}

function LeagueSignalsPanel({ performance, scorers }: { performance: TeamPerformance[]; scorers: Array<{ name: string; teamName: string; goals: number }> }) {
  const boot = [...scorers].sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name)).slice(0, 3);
  const glove = [...performance].sort((a, b) => b.cleanSheets - a.cleanSheets || a.goalsAgainst - b.goalsAgainst || a.teamName.localeCompare(b.teamName)).slice(0, 3);
  const hasResults = performance.some((team) => team.matchesPlayed > 0) || boot.length > 0;
  return <section className="panel league-signals-panel"><div className="panel-header"><div><p className="eyebrow">LEAGUE SIGNALS</p><h2>Records from the pitch</h2><p className="section-caption">Confirmed results only. These rankings update when the official table moves.</p></div><BarChart3 size={18} className="panel-icon" /></div>{hasResults ? <div className="signal-grid"><article className="signal-card"><div className="signal-card-heading"><span className="signal-badge signal-badge-gold">GOLDEN BOOT</span><small>Official goals</small></div>{boot.length ? <div className="signal-list">{boot.map((player, index) => <div className="signal-row" key={`${player.teamName}-${player.name}`}><span className={`signal-rank ${index === 0 ? "leader" : ""}`}>{String(index + 1).padStart(2, "0")}</span><div><strong>{player.name}</strong><small>{player.teamName}</small></div><b>{player.goals}</b></div>)}</div> : <div className="designed-empty-state"><Trophy size={20} /><strong>No official scorers yet</strong><span>Confirmed goals will populate the race.</span></div>}</article><article className="signal-card"><div className="signal-card-heading"><span className="signal-badge signal-badge-blue">GOLDEN GLOVE</span><small>Clean sheets</small></div>{glove.length ? <div className="signal-list">{glove.map((team, index) => <div className="signal-row" key={team.teamId}><span className={`signal-rank ${index === 0 ? "leader" : ""}`}>{String(index + 1).padStart(2, "0")}</span><div><strong>{team.teamName}</strong><small>{team.goalsAgainst} conceded · {team.matchesPlayed} played</small></div><b>{team.cleanSheets}</b></div>)}</div> : <div className="designed-empty-state"><ShieldCheck size={20} /><strong>No clean sheets yet</strong><span>Defensive records appear after confirmed matches.</span></div>}</article></div> : <div className="designed-empty-state designed-empty-wide"><BarChart3 size={24} /><strong>The first records are waiting</strong><span>Confirm a match to unlock the league’s scoring and defensive races.</span></div>}</section>;
}

function ScorerReviewPanel({ reviews, onAnalyze, onApprove, onReject, busy }: { reviews: BackendScorerReview[]; onAnalyze: () => void; onApprove: (reviewId: number, approvedName: string) => void; onReject: (reviewId: number) => void; busy: boolean }) {
  const [editedNames, setEditedNames] = useState<Record<number, string>>({});
  const actionable = reviews.filter((review) => review.status === "PENDING" || review.status === "FAILED");
  return <section className="panel scorer-review-panel"><div className="panel-header"><div><p className="eyebrow">AI NAME REVIEW</p><h2>{actionable.length ? `${actionable.length} names need your decision` : "Scorer names are clear"}</h2><p className="section-caption">Hugging Face suggests a full footballer name. You can edit it yourself, then approve it. Nothing becomes official automatically.</p></div><Button onClick={onAnalyze} disabled={busy || !reviews.some((review) => review.status === "FAILED" || review.status === "PENDING")}><Sparkles size={15} /> {busy ? "Analyzing…" : "Analyze names"}</Button></div>{!reviews.length ? <div className="scorer-review-empty"><Sparkles size={22} /><strong>No scorer names are waiting.</strong><span>New submitted goals will appear here for AI-assisted review.</span></div> : <div className="scorer-review-list">{reviews.slice(0, 50).map((review) => { const confidence = review.confidence === null ? null : Math.round(review.confidence * 100); const editable = review.status === "PENDING" || review.status === "FAILED"; const editedName = editedNames[review.id] ?? review.suggested_name ?? ""; const canDecide = editable && Boolean(editedName.trim()); return <article className={`scorer-review-row review-${review.status.toLowerCase()}`} key={review.id}><div className="scorer-review-main"><div className="scorer-review-context"><span className="scorer-review-status">{review.status === "FAILED" ? "Analysis failed" : review.status === "PENDING" ? review.suggested_name ? "Awaiting approval" : "Queued for analysis" : review.status}</span><small>{review.team_name} · {review.home_team_name} vs {review.away_team_name} · Matchday {review.matchday}</small></div><div className="scorer-name-comparison"><div><small>Submitted name</small><strong>{review.submitted_name}</strong></div><ArrowRight size={15} /><div className="scorer-edit-field"><small>{editable ? "Full name to approve" : "Approved full name"}</small>{editable ? <input value={editedName} onChange={(event) => setEditedNames((current) => ({ ...current, [review.id]: event.target.value }))} placeholder="e.g. Alessandro Del Piero" aria-label={`Full name for ${review.submitted_name}`} maxLength={120} /> : <strong>{review.approved_name || review.suggested_name || "—"}</strong>}</div></div><p className="scorer-review-reason">{review.error_message || review.reason || (editable ? "Edit the full name if needed, then approve it." : "The approved name is now official.")}{confidence !== null && <span className="scorer-confidence">{confidence}% confidence</span>}</p></div>{canDecide && <div className="scorer-review-actions"><Button onClick={() => onApprove(review.id, editedName.trim())}><Check size={14} /> Approve name</Button><Button variant="outline" onClick={() => onReject(review.id)}><X size={14} /> Reject</Button></div>}</article>; })}</div>}</section>;
}

function PlayerRegistryPanel({ players, onRename, busy }: { players: BackendPlayerRegistryEntry[]; onRename: (player: BackendPlayerRegistryEntry, newName: string) => Promise<boolean>; busy: boolean }) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const grouped = players.reduce<Record<string, { teamId: number; teamName: string; shortCode: string; accent: string; players: BackendPlayerRegistryEntry[] }>>((groups, player) => {
    const key = String(player.team_id);
    if (!groups[key]) groups[key] = { teamId: Number(player.team_id), teamName: player.team_name, shortCode: player.short_code, accent: player.accent, players: [] };
    groups[key].players.push(player);
    return groups;
  }, {});
  const teamGroups = Object.values(grouped);
  function rowKey(player: BackendPlayerRegistryEntry) {
    return `${player.team_id}-${player.player_email || "unlinked"}-${player.scorer_name}`;
  }
  function beginEdit(player: BackendPlayerRegistryEntry) {
    setEditingKey(rowKey(player));
    setDraftName(player.scorer_name);
  }
  async function saveEdit(player: BackendPlayerRegistryEntry) {
    if (!draftName.trim()) return;
    const saved = await onRename(player, draftName.trim());
    if (saved) {
      setEditingKey(null);
      setDraftName("");
    }
  }
  return <section className="panel player-registry-panel"><div className="panel-header player-registry-header"><div><p className="eyebrow">PLAYER REGISTRY</p><h2>{players.length ? `${players.length} scorer identities by team` : "No scorer identities yet"}</h2><p className="section-caption">Every name below comes from the goals table. Save is an admin approval: it updates every matching goal for that team and keeps the AI review records aligned.</p></div><div className="player-registry-art" aria-hidden="true"><img src="/assets/football/player-registry-portrait.jpg" alt="" /></div><Users size={18} className="panel-icon" /></div>{!teamGroups.length ? <div className="scorer-review-empty"><Users size={22} /><strong>Player identities will appear after the first goal is logged.</strong><span>Pending and confirmed goals are grouped here automatically.</span></div> : <div className="player-registry-groups">{teamGroups.map((group) => <article className="player-registry-team" key={group.teamId} style={{ "--registry-accent": group.accent } as CSSProperties}><div className="player-registry-team-heading"><div><span className="player-registry-code">{group.shortCode}</span><div><h3>{group.teamName}</h3><small>{group.players.length} scorer {group.players.length === 1 ? "identity" : "identities"}</small></div></div><span className="player-registry-team-mark">{initials(group.teamName)}</span></div><div className="player-registry-list">{group.players.map((player) => { const key = rowKey(player); const editing = editingKey === key; const official = Number(player.official_goals); const total = Number(player.total_goals); return <div className={`player-registry-row ${editing ? "is-editing" : ""}`} key={key}><div className="player-registry-identity"><span className="scorer-avatar">{initials(player.scorer_name)}</span>{editing ? <form className="player-registry-edit" onSubmit={(event) => { event.preventDefault(); void saveEdit(player); }}><input autoFocus value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={120} aria-label={`Rename ${player.scorer_name}`} /><small>Admin approval required before this becomes the official name.</small><div><button type="submit" className="row-action" disabled={busy || !draftName.trim()}><Check size={13} /> {busy ? "Saving…" : "Approve rename"}</button><button type="button" className="row-action row-action-secondary" onClick={() => { setEditingKey(null); setDraftName(""); }} disabled={busy}><X size={13} /> Cancel</button></div></form> : <div><strong>{player.scorer_name}</strong><small>{player.player_email || "Unlinked scorer identity"}</small></div>}</div><div className="player-registry-metrics"><span><b>{official}</b><small>official</small></span><span><b>{Math.max(0, total - official)}</b><small>pending</small></span><span><b>{total}</b><small>total goals</small></span></div>{!editing && <button className="icon-button" onClick={() => beginEdit(player)} disabled={busy} aria-label={`Edit ${player.scorer_name} for ${group.teamName}`}><Pencil size={14} /></button>}</div>; })}</div></article>)}</div>}</section>;
}

function AdminUserEditor({ account, teams, busy, onCancel, onSave }: { account: UserAccount; teams: Team[]; busy: boolean; onCancel: () => void; onSave: (email: string, payload: { displayName: string; role: "admin" | "player"; status: "ACTIVE" | "INVITED" | "DISABLED"; teamId: number | null }) => void }) {
  const [displayName, setDisplayName] = useState(account.name);
  const [role, setRole] = useState<"admin" | "player">(account.role);
  const [status, setStatus] = useState<"ACTIVE" | "INVITED" | "DISABLED">(account.status ?? (account.active ? "ACTIVE" : "DISABLED"));
  const [teamId, setTeamId] = useState(account.teamId ?? "");
  return <form className="admin-user-editor" onSubmit={(event) => { event.preventDefault(); onSave(account.email, { displayName: displayName.trim(), role, status, teamId: role === "player" && teamId ? Number(teamId) : null }); }}>
    <div className="admin-user-editor-heading"><div><strong>Edit account</strong><small>{account.email}</small></div><button type="button" className="icon-button" onClick={onCancel} aria-label="Cancel account edit"><X size={15} /></button></div>
    <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} required /></label>
    <div className="admin-user-editor-grid"><label>Role<select value={role} onChange={(event) => setRole(event.target.value as "admin" | "player")}><option value="player">Player</option><option value="admin">Admin</option></select></label><label>Status<select value={status} onChange={(event) => setStatus(event.target.value as "ACTIVE" | "INVITED" | "DISABLED")}><option value="ACTIVE">Active</option><option value="INVITED">Invited</option><option value="DISABLED">Disabled</option></select></label></div>
    <label>Assigned team<select value={teamId} onChange={(event) => setTeamId(event.target.value)} disabled={role === "admin"}><option value="">No team assignment</option>{teams.filter((team) => team.approvalStatus !== "REJECTED").map((team) => <option key={team.id} value={team.id}>{team.shortName} · {team.name}</option>)}</select></label>
    <div className="admin-user-editor-actions"><button type="button" className="row-action row-action-secondary" onClick={onCancel}>Cancel</button><button type="submit" className="row-action" disabled={busy || !displayName.trim()}>{busy ? "Saving…" : "Save account"}<Check size={14} /></button></div>
  </form>;
}

function NotificationPanel({ snapshot, onRefresh, onSend, busy, sending }: { snapshot: BackendNextFixtureNotificationsResponse | null; onRefresh: () => void; onSend: () => void; busy: boolean; sending: boolean }) {
  const notifications = snapshot?.notifications || [];
  const recipientCount = notifications.reduce((total, item) => total + item.recipients.length, 0);
  function formatKickoff(timestamp: number) {
    return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(timestamp));
  }
  return <section className="panel notification-panel"><div className="panel-header notification-panel-header"><div><p className="eyebrow">MATCHDAY MAILROOM</p><h2>Notify players about what is next</h2><p className="section-caption">Preview each team’s immediate next fixture, opponent snapshot, and live table position before sending one personalized card per active player.</p></div><div className="notification-panel-actions"><Button variant="outline" onClick={onRefresh} disabled={busy || sending}><RefreshCw size={15} /> {busy ? "Loading…" : "Refresh preview"}</Button><Button onClick={onSend} disabled={busy || sending || !notifications.length || !snapshot?.providerConfigured || recipientCount === 0}><Bell size={15} /> {sending ? "Sending…" : "Notify players"}</Button></div></div>{snapshot && <div className="notification-status-row"><span className={`notification-provider ${snapshot.providerConfigured ? "is-ready" : "is-missing"}`}><span />{snapshot.providerConfigured ? "Gmail relay ready" : "Gmail relay setup needed"}</span><span>{snapshot.seasonName} · {notifications.length} team cards · {recipientCount} recipients</span></div>}{!snapshot ? <div className="notification-empty"><Bell size={22} /><strong>Load the next-fixture preview to begin.</strong><span>The preview reads the live schedule and standings; nothing is sent until you press Notify players.</span></div> : !notifications.length ? <div className="notification-empty"><CalendarDays size={22} /><strong>No scheduled fixtures remain.</strong><span>There is no next fixture to notify about for the active season.</span></div> : <div className="notification-grid">{notifications.map((notification: BackendNextFixtureNotification) => <article className="notification-card" key={notification.teamId}><div className="notification-card-top"><span className="notification-team-chip" style={{ "--notification-accent": notification.teamAccent } as CSSProperties}>{notification.teamShortCode}</span><span className="notification-matchday">Matchday {notification.fixture.matchday}</span><span className="notification-recipient-count">{notification.recipients.length} recipient{notification.recipients.length === 1 ? "" : "s"}</span></div><div className="notification-fixture-line"><div><strong>{notification.teamName}</strong><small>{notification.fixture.isHome ? "Home" : "Away"}</small></div><span>vs</span><div className="notification-opponent"><strong>{notification.fixture.opponent.name}</strong><small>{notification.fixture.isHome ? "Away" : "Home"}</small></div></div><div className="notification-kickoff"><CalendarDays size={14} /><span>{formatKickoff(notification.fixture.kickoffAt)} · IST</span></div><div className="notification-fact-grid"><div><b>#{notification.table.rank}</b><small>Your position</small></div><div><b>{notification.table.points} pts</b><small>Your points</small></div><div><b>#{notification.opponentTable.rank}</b><small>Opponent position</small></div><div><b>{notification.opponentTable.cleanSheets}</b><small>Opponent clean sheets</small></div></div><p className="notification-card-copy">{notification.fixture.opponent.name} have {notification.opponentTable.points} points and a {notification.opponentTable.goalDifference >= 0 ? "+" : ""}{notification.opponentTable.goalDifference} goal difference. The email reminds players to complete the 7-minute regular-time fixture.</p></article>)}</div>}{snapshot && !snapshot.providerConfigured && <p className="notification-config-note">The live preview is ready, but the send button stays disabled until <code>GMAIL_RELAY_URL</code> and <code>GMAIL_RELAY_SECRET</code> are available in Vercel production.</p>}</section>;
}

function DatabasePanel({ database, user, players, onRenamePlayer, playerRenameBusy, scorerReviews, onAnalyzeScorerReviews, onApproveScorerReview, onRejectScorerReview, scorerReviewBusy, onUpdateUser, userEditBusy, notificationSnapshot, onRefreshNotifications, onSendNotifications, notificationBusy, notificationSending }: { database: LeagueDatabase; user: UserAccount; players: BackendPlayerRegistryEntry[]; onRenamePlayer: (player: BackendPlayerRegistryEntry, newName: string) => Promise<boolean>; playerRenameBusy: boolean; scorerReviews: BackendScorerReview[]; onAnalyzeScorerReviews: () => void; onApproveScorerReview: (reviewId: number, approvedName: string) => void; onRejectScorerReview: (reviewId: number) => void; scorerReviewBusy: boolean; onUpdateUser: (email: string, payload: { displayName: string; role: "admin" | "player"; status: "ACTIVE" | "INVITED" | "DISABLED"; teamId: number | null }) => void; userEditBusy: boolean; notificationSnapshot: BackendNextFixtureNotificationsResponse | null; onRefreshNotifications: () => void; onSendNotifications: () => void; notificationBusy: boolean; notificationSending: boolean }) {
  const [editingEmail, setEditingEmail] = useState<string | null>(null);
  const [databaseExportBusy, setDatabaseExportBusy] = useState(false);
  async function downloadDatabaseExport() {
    if (user.role !== "admin" || databaseExportBusy) return;
    setDatabaseExportBusy(true);
    try {
      const { blob, filename } = await backendDownloadDatabaseExport();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Database export downloaded", { description: "The live league records were saved as a JSON snapshot. Authentication secrets were excluded." });
    } catch (error) {
      toast.error("Database export failed", { description: error instanceof Error ? error.message : "Try again shortly." });
    } finally {
      setDatabaseExportBusy(false);
    }
  }
  return <section className="view-panel"><div className="database-hero"><div><p className="eyebrow">DATABASE CONTROL CENTER</p><h2>Identity, access & records</h2><p>All league records are typed, permission-aware, and loaded from the active league database.</p></div><div className="notification-panel-actions">{user.role === "admin" && <Button variant="outline" onClick={downloadDatabaseExport} disabled={databaseExportBusy}><Download size={15} /> {databaseExportBusy ? "Preparing JSON…" : "Download full JSON"}</Button>}<span className="health-badge"><span /> Schema healthy</span></div></div><NotificationPanel snapshot={notificationSnapshot} onRefresh={onRefreshNotifications} onSend={onSendNotifications} busy={notificationBusy} sending={notificationSending} /><div className="database-grid"><article className="panel database-card"><div className="panel-header"><div><p className="eyebrow">ACCESS DIRECTORY</p><h2>{database.users.length} accounts</h2></div><UserCog size={18} className="panel-icon" /></div><div className="user-directory">{database.users.map((account) => { const team = account.teamId ? teamById(database.teams, account.teamId) : undefined; return editingEmail === account.email ? <AdminUserEditor key={account.id} account={account} teams={database.teams} busy={userEditBusy} onCancel={() => setEditingEmail(null)} onSave={(email, payload) => onUpdateUser(email, payload)} /> : <div className="user-directory-row" key={account.id}><span className="user-avatar">{initials(account.name)}</span><div><strong>{account.name}</strong><small>{account.email}{team ? ` · ${team.name}` : " · Competition-wide"}</small></div><span className={`role-badge role-${account.role}`}>{account.role}</span>{user.role === "admin" && <button className="icon-button" aria-label={`Edit ${account.name}`} onClick={() => setEditingEmail(account.email)}><Pencil size={14} /></button>}</div>; })}</div><p className="permission-note"><ShieldCheck size={14} /> You are signed in as <strong>{user.name}</strong>. {user.role === "admin" ? "Admin actions are unlocked." : "Player actions are limited to assigned fixtures."}</p></article><article className="panel database-card"><div className="panel-header"><div><p className="eyebrow">RECORD COUNTS</p><h2>Source of truth</h2></div><Database size={18} className="panel-icon" /></div><div className="record-counts"><div><strong>{database.teams.length}</strong><span>teams</span></div><div><strong>{database.matches.length}</strong><span>fixtures</span></div><div><strong>{database.matches.filter((match) => match.status === "CONFIRMED").length}</strong><span>official results</span></div><div><strong>{database.users.length}</strong><span>users</span></div></div><p className="muted-copy">This dashboard is connected to the production database. Empty sections mean records have not been created yet.</p></article></div>{user.role === "admin" && <PlayerRegistryPanel players={players} onRename={onRenamePlayer} busy={playerRenameBusy} />}<ScorerReviewPanel reviews={scorerReviews} onAnalyze={onAnalyzeScorerReviews} onApprove={onApproveScorerReview} onReject={onRejectScorerReview} busy={scorerReviewBusy} /></section>;
}

function RulesPanel({ rules, isAdmin, onReset }: { rules: TiebreakerRule[]; isAdmin: boolean; onReset: () => void }) {
  return <section className="view-panel"><div className="database-hero"><div><p className="eyebrow">COMPETITION RULES</p><h2>Clear rules. Clean matchdays.</h2><p>Every player knows the match format, result workflow, and automatic tie-breaker order before kickoff.</p></div><span className="health-badge"><ListChecks size={14} /> Live calculation</span></div><div className="competition-rule-grid"><article><span className="competition-rule-kicker">MATCH LENGTH</span><strong>7 minutes</strong><p>Play the full seven-minute match before reporting the final score.</p></article><article><span className="competition-rule-kicker">MATCH READINESS</span><strong>Both sides ready</strong><p>Both players should be ready before kickoff and agree the result after the match.</p></article><article><span className="competition-rule-kicker">EXTRA TIME</span><strong>Not used</strong><p>League fixtures are decided in regular time. No extra time is added.</p></article></div><div className="rules-card panel"><div className="rule-list">{rules.map((rule, index) => <div className="rule-row" key={rule}><span className="rule-number">{index + 1}</span><div><strong>{ruleLabel(rule)}</strong><small>{rule === "points" ? "3 for a win · 1 for a draw" : rule === "goalDifference" ? "Goals scored minus goals conceded" : rule === "goalsFor" ? "Total goals scored" : rule === "headToHead" ? "Points earned in direct meetings" : "Number of wins"}</small></div><span className="rule-status">Automatic</span></div>)}</div><div className="rule-footer"><span><ShieldCheck size={15} /> Standings update only from confirmed results.</span>{isAdmin ? <Button variant="outline" onClick={onReset}>Reset default order</Button> : <small>Admin only · rule configuration</small>}</div></div></section>;
}

function ResultDrawer({ database, matchId, playerStats, useBackend, onClose, onSave }: { database: LeagueDatabase; matchId: string; playerStats: PlayerStat[]; useBackend: boolean; onClose: () => void; onSave: (matchId: string, homeScore: number, awayScore: number, goals: Goal[]) => void }) {
  const match = database.matches.find((item) => item.id === matchId);
  const home = match ? teamById(database.teams, match.homeTeamId) : undefined;
  const away = match ? teamById(database.teams, match.awayTeamId) : undefined;
  const liveStats = playerStats.filter((player) => player.teamId === match?.homeTeamId || player.teamId === match?.awayTeamId);
  const [homeScore, setHomeScore] = useState(match?.homeScore?.toString() ?? "");
  const [awayScore, setAwayScore] = useState(match?.awayScore?.toString() ?? "");
  const [scorers, setScorers] = useState<ResultInput[]>(() => (match?.goals ?? []).map((goal) => ({ id: goal.id, teamId: goal.teamId, playerName: goal.playerName, playerEmail: goal.playerEmail, minute: String(goal.minute) })));
  const [scorerSuggestions, setScorerSuggestions] = useState<Record<string, Array<{ name: string; email: string | null; goals: number }>>>({});

  useEffect(() => {
    if (!useBackend || !match || !home || !away) return;
    const teamIds = Array.from(new Set([home.id, away.id]));
    Promise.all(teamIds.map(async (teamId) => [teamId, (await backendScorerSuggestions(teamId)).scorers] as const))
      .then((entries) => setScorerSuggestions(Object.fromEntries(entries)))
      .catch(() => undefined);
  }, [useBackend, match?.id, home?.id, away?.id]);

  if (!match || !home || !away) return null;
  const totalGoals = (Number(homeScore) || 0) + (Number(awayScore) || 0);
  const loggedGoals = scorers.filter((goal) => goal.playerName.trim() && goal.minute).length;
  const missingGoals = Math.max(0, totalGoals - loggedGoals);

  function addGoal(teamId = home?.id ?? match?.homeTeamId ?? "") {
    setScorers((current) => [...current, { id: makeId("goal"), teamId, playerName: "", minute: "" }]);
  }

  function updateGoal(id: string, key: keyof ResultInput, value: string) {
    setScorers((current) => current.map((goal) => goal.id === id ? { ...goal, [key]: value } : goal));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const homeValue = Number(homeScore);
    const awayValue = Number(awayScore);
    if (!Number.isInteger(homeValue) || homeValue < 0 || !Number.isInteger(awayValue) || awayValue < 0) {
      toast.error("Add a valid score for both teams.");
      return;
    }
    const goals = scorers.filter((goal) => goal.playerName.trim()).map((goal) => ({ id: goal.id, teamId: goal.teamId, playerName: goal.playerName.trim(), playerEmail: goal.playerEmail, minute: Number(goal.minute) || 0 }));
    if (!match) return;
    onSave(match.id, homeValue, awayValue, goals);
  }

  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="result-drawer" role="dialog" aria-modal="true" aria-labelledby="result-drawer-title">
        <div className="drawer-header"><div><p className="eyebrow">MATCH RESULT</p><h2 id="result-drawer-title">Log the final score</h2><p>Home team submits first. The away team can confirm it afterwards.</p></div><button className="icon-button" aria-label="Close result form" onClick={onClose}><X size={18} /></button></div>
        <form onSubmit={submit}>
          <div className="scoreboard-input">
            <div className="score-team"><TeamMark team={home} size="lg" /><strong>{home.name}</strong><span>HOME</span></div>
            <input aria-label={`${home.name} score`} inputMode="numeric" min="0" max="99" type="number" value={homeScore} onChange={(event) => setHomeScore(event.target.value)} placeholder="0" />
            <span className="score-divider">–</span>
            <input aria-label={`${away.name} score`} inputMode="numeric" min="0" max="99" type="number" value={awayScore} onChange={(event) => setAwayScore(event.target.value)} placeholder="0" />
            <div className="score-team"><TeamMark team={away} size="lg" /><strong>{away.name}</strong><span>AWAY</span></div>
          </div>
          <div className="drawer-live-stats"><div><p className="eyebrow">LIVE PLAYER STATS</p><strong>Use recent form to log scorers faster.</strong></div><div className="drawer-stat-list">{liveStats.slice(0, 4).map((player) => <span key={`${player.teamId}-${player.playerEmail || player.name}`}><b>{player.name}</b><small>{player.teamName} · {player.officialGoals} official · {player.pendingGoals} pending · avg {player.averageMinute || "—"}′</small></span>)}{!liveStats.length && <small>No scorer history for these teams yet.</small>}</div></div>
          <div className="drawer-section-heading"><div><p className="eyebrow">GOAL LOG</p><h3>Who found the net?</h3></div><span className="goal-counter">{loggedGoals} / {totalGoals} logged</span></div>
          {missingGoals > 0 && <div className="drawer-hint"><CircleHelp size={15} /><span>{missingGoals} goal{missingGoals === 1 ? "" : "s"} still need a scorer. You can add the details now or save the score and complete them later.</span></div>}
          <div className="goal-log">
            {scorers.length === 0 && <div className="goal-empty"><Trophy size={18} /><span>Adding scorers keeps the Golden Boot accurate.</span></div>}
            {scorers.map((goal, index) => (
              <div className="goal-row" key={goal.id}>
                <span className="goal-index">{String(index + 1).padStart(2, "0")}</span>
                <select aria-label={`Goal ${index + 1} team`} value={goal.teamId} onChange={(event) => setScorers((current) => current.map((item) => item.id === goal.id ? { ...item, teamId: event.target.value, playerEmail: undefined } : item))}><option value={home.id}>{home.shortName} · {home.name}</option><option value={away.id}>{away.shortName} · {away.name}</option></select>
                <input aria-label={`Goal ${index + 1} scorer for ${goal.teamId === home.id ? home.name : away.name}`} list={`scorers-${goal.teamId}`} value={goal.playerName} onChange={(event) => { const value = event.target.value; const suggestion = scorerSuggestions[goal.teamId]?.find((item) => item.name.toLowerCase() === value.trim().toLowerCase()); setScorers((current) => current.map((item) => item.id === goal.id ? { ...item, playerName: value, playerEmail: suggestion?.email || undefined } : item)); }} placeholder={`Player from ${goal.teamId === home.id ? home.shortName : away.shortName}`} />
                <datalist id={`scorers-${goal.teamId}`}>{(scorerSuggestions[goal.teamId] || playerStats.filter((player) => player.teamId === goal.teamId).map((player) => ({ name: player.name, email: player.playerEmail || null, goals: player.totalGoals }))).map((scorer) => <option key={`${goal.teamId}-${scorer.email || scorer.name}`} value={scorer.name}>{goal.teamId === home.id ? home.name : away.name} · {scorer.goals} previous goal{scorer.goals === 1 ? "" : "s"}</option>)}</datalist>
                <div className="minute-input"><input aria-label={`Goal ${index + 1} minute`} inputMode="numeric" type="number" min="1" max="120" value={goal.minute} onChange={(event) => updateGoal(goal.id, "minute", event.target.value)} placeholder="Min" /><span>′</span></div>
                <button type="button" className="icon-button" aria-label={`Remove goal ${index + 1}`} onClick={() => setScorers((current) => current.filter((item) => item.id !== goal.id))}><X size={15} /></button>
              </div>
            ))}
          </div>
          <button type="button" className="add-goal-button" onClick={() => addGoal(scorers.length && scorers[scorers.length - 1].teamId === away.id ? away.id : home.id)}><Plus size={15} /> Add scorer</button>
          <div className="drawer-footer"><div className="save-note"><ShieldCheck size={16} /><span>Saved to the league database<br /><small>Awaiting away-team confirmation</small></span></div><div className="drawer-actions"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit">Save result <ArrowRight size={15} /></Button></div></div>
        </form>
      </aside>
    </div>
  );
}

function AddTeamPanel({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string, shortName: string, manager: string) => void }) {
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [manager, setManager] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !shortName.trim() || !manager.trim()) {
      toast.error("Complete the team name, code, and manager.");
      return;
    }
    onAdd(name.trim(), shortName.trim().slice(0, 3).toUpperCase(), manager.trim());
  }
  return <div className="inline-form-card"><div className="inline-form-heading"><div><p className="eyebrow">NEW RECORD</p><h3>Add a team</h3></div><button className="icon-button" onClick={onClose}><X size={17} /></button></div><form className="team-form" onSubmit={submit}><label>Team name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Capital United" /></label><label>Short code<input value={shortName} onChange={(event) => setShortName(event.target.value)} maxLength={3} placeholder="CAP" /></label><label>Manager / eFootball username<input value={manager} onChange={(event) => setManager(event.target.value)} placeholder="Player name" /></label><div className="inline-form-actions"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit">Add team <ArrowRight size={15} /></Button></div></form></div>;
}

function EditTeamPanel({ team, onClose, onSave }: { team: Team; onClose: () => void; onSave: (name: string, shortCode: string) => void }) {
  const [name, setName] = useState(team.name);
  const [shortCode, setShortCode] = useState(team.shortName);
  function submit(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    const nextCode = shortCode.trim().toUpperCase();
    if (!nextName || !nextCode) {
      toast.error("Complete the team name and team code.");
      return;
    }
    if (nextCode.length < 2 || nextCode.length > 12 || !/^[A-Z0-9]+$/.test(nextCode)) {
      toast.error("Team code must contain 2 to 12 letters or numbers.");
      return;
    }
    onSave(nextName, nextCode);
  }
  return <div className="inline-form-card team-edit-panel"><div className="inline-form-heading"><div><p className="eyebrow">ADMIN EDIT</p><h3>Update {team.name}</h3><p className="form-help">Changing these labels keeps the same team ID, members, fixtures, and results.</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close team editor"><X size={17} /></button></div><form className="team-form" onSubmit={submit}><label>Team name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoFocus /></label><label>Team code<input value={shortCode} onChange={(event) => setShortCode(event.target.value.toUpperCase())} maxLength={12} placeholder="CAP" /></label><div className="inline-form-actions"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit"><Check size={15} /> Save changes</Button></div></form></div>;
}

export default function Home() {
  const { theme, toggleTheme } = useTheme();
  const [database, setDatabase] = useState<LeagueDatabase>(() => getDatabase());
  const [remoteUser, setRemoteUser] = useState<UserAccount | null | undefined>(undefined);
  const [activeView, setActiveView] = useState<View>("overview");
  const [resultMatchId, setResultMatchId] = useState<string | null>(null);
  const [detailMatchId, setDetailMatchId] = useState<number | null>(null);
  const [showTeamForm, setShowTeamForm] = useState(false);
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [fixtureScope, setFixtureScope] = useState<"mine" | "all">("all");
  const [fixtureFilter, setFixtureFilter] = useState<"all" | "upcoming" | "pending" | "completed">("all");
  const [selectedMatchday, setSelectedMatchday] = useState<number | "all">("all");
  const [expandedMatchdays, setExpandedMatchdays] = useState<number[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [scorerReviews, setScorerReviews] = useState<BackendScorerReview[]>([]);
  const [playerRegistry, setPlayerRegistry] = useState<BackendPlayerRegistryEntry[]>([]);
  const [scorerReviewBusy, setScorerReviewBusy] = useState(false);
  const [playerRenameBusy, setPlayerRenameBusy] = useState(false);
  const [userEditBusy, setUserEditBusy] = useState(false);
  const [newsBusy, setNewsBusy] = useState(false);
  const [notificationSnapshot, setNotificationSnapshot] = useState<BackendNextFixtureNotificationsResponse | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationSending, setNotificationSending] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);

  const useBackend = backendEnabled();
  useEffect(() => saveDatabase(database), [database]);
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!useBackend) {
      setRemoteUser(null);
      return;
    }
    backendMe().then((result) => setRemoteUser(result ? toLocalUser(result) : null));
  }, [useBackend]);
  useEffect(() => {
    if (!useBackend || !remoteUser) return;
    Promise.all([backendDashboard(), remoteUser.role === "admin" ? backendGetPlayers() : Promise.resolve({ players: [] as BackendPlayerRegistryEntry[] })])
      .then(([snapshot, registry]) => { setDatabase((current) => mergeBackendDashboard(current, snapshot)); setScorerReviews(snapshot.scorerReviews || []); setPlayerRegistry(registry.players); })
      .catch((error) => toast.error("Could not load league data", { description: error instanceof Error ? error.message : "Try again shortly." }));
  }, [useBackend, remoteUser?.id, remoteUser?.role]);
  useEffect(() => {
    if (!useBackend || remoteUser?.role !== "admin") {
      setNotificationSnapshot(null);
      return;
    }
    backendGetNextFixtureNotifications().then(setNotificationSnapshot).catch((error) => toast.error("Could not load match mail preview", { description: error instanceof Error ? error.message : "Try again shortly." }));
  }, [useBackend, remoteUser?.id, remoteUser?.role]);

  const user = useBackend ? remoteUser : getCurrentUser(database);
  const isAdmin = user?.role === "admin";
  useEffect(() => {
    if (isAdmin === false && activeView === "league-tools") setActiveView("overview");
  }, [activeView, isAdmin]);
  const standings = useMemo(() => calculateStandings(database), [database]);
  const scorers = useMemo(() => leaderboard(database), [database]);
  const playerStats = useMemo(() => livePlayerStats(database), [database]);
  const teamPerformance = useMemo(() => calculateTeamPerformance(database), [database]);
  const confirmedCount = countConfirmed(database);
  const pendingCount = countPending(database);
  const nextMatch = database.matches.find((match) => match.status === "SCHEDULED");
  const pendingMatch = database.matches.find((match) => match.status === "PENDING");
  const ownedMatches = useMemo(() => user ? database.matches.filter((match) => isUserFixture(match, user)) : [], [database.matches, user?.teamId]);
  const scopedMatches = useMemo(() => fixtureScope === "mine" && user?.teamId ? ownedMatches : database.matches, [database.matches, fixtureScope, ownedMatches, user?.teamId]);
  const filteredMatches = useMemo(() => scopedMatches.filter((match) => {
    const statusMatch = fixtureFilter === "all" || (fixtureFilter === "upcoming" && match.status === "SCHEDULED") || (fixtureFilter === "pending" && (match.status === "PENDING" || match.status === "DISPUTED")) || (fixtureFilter === "completed" && match.status === "CONFIRMED");
    const home = teamById(database.teams, match.homeTeamId)?.name.toLowerCase() ?? "";
    const away = teamById(database.teams, match.awayTeamId)?.name.toLowerCase() ?? "";
    return statusMatch && (!searchTerm || home.includes(searchTerm.toLowerCase()) || away.includes(searchTerm.toLowerCase()));
  }), [database.teams, fixtureFilter, scopedMatches, searchTerm]);
  const todayMatches = useMemo(() => database.matches.filter((match) => match.date === dateKey(new Date(clockNow))), [database.matches, clockNow]);
  const groupedFixtures = useMemo(() => Array.from(new Set(filteredMatches.map((match) => match.matchday))).map((matchday) => ({ matchday, matches: filteredMatches.filter((match) => match.matchday === matchday) })), [filteredMatches]);
  const visibleFixtureGroups = useMemo(() => selectedMatchday === "all" ? groupedFixtures : groupedFixtures.filter((group) => group.matchday === selectedMatchday), [groupedFixtures, selectedMatchday]);
  useEffect(() => {
    if (selectedMatchday !== "all" && !groupedFixtures.some((group) => group.matchday === selectedMatchday)) setSelectedMatchday("all");
  }, [groupedFixtures, selectedMatchday]);
  const liveMatchday = useMemo(() => {
    const matchdays = database.matches.map((match) => ({ matchday: Number(match.matchday), date: match.date })).filter((match) => Number.isFinite(match.matchday) && match.matchday > 0);
    if (!matchdays.length) return 0;
    const today = leagueDateKey(new Date(clockNow));
    const openMatchdays = matchdays.filter((match) => match.date && match.date <= today).map((match) => match.matchday);
    return openMatchdays.length ? Math.max(...openMatchdays) : Math.min(...matchdays.map((match) => match.matchday));
  }, [database.matches, clockNow]);
  const userTeam = user?.teamId ? teamById(database.teams, user.teamId) : undefined;


  function handleLogin(nextUser: UserAccount) {
    setDatabase((current) => ({ ...current, currentUserId: nextUser.id }));
  }

  async function signOut() {
    if (useBackend) await backendLogout().catch(() => undefined);
    setRemoteUser(null);
    setDatabase((current) => ({ ...current, currentUserId: null }));
    setResultMatchId(null);
    toast("Signed out", { description: useBackend ? "Your secure session has ended." : "Your league data remains saved on this browser." });
  }

  function openResult(matchId?: string) {
    if (!isAdmin) {
      toast("Admin-only action", { description: "Only the league administrator can enter, confirm, or adjust results." });
      return;
    }
    const id = matchId ?? pendingMatch?.id ?? nextMatch?.id;
    if (!id) {
      toast("Every fixture already has a result.", { description: "The league is ready for the next season." });
      return;
    }
    const match = database.matches.find((item) => item.id === id);
    if (!user || !match) {
      toast.error("Fixture unavailable", { description: "That fixture is no longer in the live league database." });
      return;
    }
    if (!isMatchDateOpen(match)) {
      toast("Matchday is not open yet", { description: `This result opens from ${formatMatchDate(match.date)} in league time. The listed kickoff is ${formatMatchKickoff(match)}.` });
      return;
    }
    if (user.role !== "admin" && user.teamId !== match.homeTeamId) {
      toast("Home team entry only", { description: "The home team enters the score. The away team can view the fixture and wait for confirmation." });
      return;
    }
    if (!canSubmitMatch(user, match)) {
      toast.error("Result entry is unavailable", { description: "This fixture may already be official or awaiting review." });
      return;
    }
    setResultMatchId(id);
  }

  function openMatchDetails(matchId: string) {
    const numericId = Number(matchId);
    if (!Number.isFinite(numericId)) {
      toast.error("Fixture unavailable", { description: "That fixture has an invalid match identifier." });
      return;
    }
    setDetailMatchId(numericId);
  }

  async function refreshRemoteDashboard() {
    if (!useBackend) return;
    const [snapshot, registry] = await Promise.all([backendDashboard(), isAdmin ? backendGetPlayers() : Promise.resolve({ players: [] as BackendPlayerRegistryEntry[] })]);
    setDatabase((current) => mergeBackendDashboard(current, snapshot));
    setScorerReviews(snapshot.scorerReviews || []);
    if (isAdmin) setPlayerRegistry(registry.players);
  }

  async function renamePlayer(player: BackendPlayerRegistryEntry, newName: string) {
    if (!isAdmin || !useBackend) return false;
    setPlayerRenameBusy(true);
    try {
      const result = await backendRenamePlayer(Number(player.team_id), player.scorer_name, newName, player.player_email);
      setPlayerRegistry(result.players);
      await refreshRemoteDashboard();
      toast.success("Player name approved", { description: `${result.updated} goal${result.updated === 1 ? "" : "s"} updated for ${player.team_name}.` });
      return true;
    } catch (error) {
      toast.error("Player name was not updated", { description: error instanceof Error ? error.message : "Try again shortly." });
      return false;
    } finally {
      setPlayerRenameBusy(false);
    }
  }

  async function updateUserAccount(email: string, payload: { displayName: string; role: "admin" | "player"; status: "ACTIVE" | "INVITED" | "DISABLED"; teamId: number | null }) {
    if (!isAdmin || !useBackend) return;
    setUserEditBusy(true);
    try {
      await backendUpdateUser(email, payload);
      await refreshRemoteDashboard();
      if (email === user?.email) {
        const refreshed = await backendMe();
        setRemoteUser(refreshed ? toLocalUser(refreshed) : null);
      }
      toast.success("Account updated", { description: `${payload.displayName} now has the selected role, status, and team assignment.` });
    } catch (error) {
      toast.error("Account could not be updated", { description: error instanceof Error ? error.message : "Try again shortly." });
    } finally { setUserEditBusy(false); }
  }

  async function refreshNotificationPreview() {
    if (!isAdmin || !useBackend) return;
    setNotificationBusy(true);
    try {
      setNotificationSnapshot(await backendGetNextFixtureNotifications());
      toast.success("Matchday mail preview refreshed", { description: "The preview now reflects the latest fixtures and table positions." });
    } catch (error) {
      toast.error("Mail preview failed", { description: error instanceof Error ? error.message : "Try again shortly." });
    } finally { setNotificationBusy(false); }
  }
  async function sendNotifications() {
    if (!isAdmin || !useBackend) return;
    if (!notificationSnapshot?.notifications.some((notification) => notification.recipients.length)) {
      toast("No active recipients", { description: "Assign active player accounts to teams before sending." });
      return;
    }
    setNotificationSending(true);
    try {
      const result = await backendSendNextFixtureNotifications();
      setNotificationSnapshot(result);
      toast.success("Matchday notifications sent", { description: `${result.sent} recipient${result.sent === 1 ? "" : "s"} processed${result.failed.length ? `; ${result.failed.length} failed and need review.` : "."}` });
    } catch (error) {
      toast.error("Notifications could not be sent", { description: error instanceof Error ? error.message : "Check the sender configuration and try again." });
    } finally { setNotificationSending(false); }
  }
  async function refreshNewsroom() {
    if (!isAdmin || !useBackend) return;
    setNewsBusy(true);
    try {
      const result = await backendRefreshNews();
      await refreshRemoteDashboard();
      toast.success("Newsroom updated", { description: `${result.generated} evidence-backed story${result.generated === 1 ? "" : "ies"} are ready for the league.` });
    } catch (error) {
      toast.error("Newsroom refresh failed", { description: error instanceof Error ? error.message : "Try again shortly." });
    } finally { setNewsBusy(false); }
  }

  async function publishPundit(input: { seasonId: number | null; publishDate: string; section: string; headline: string; dek: string; body: string; imageKey: string; facts: string[] }) {
    if (!isAdmin || !useBackend) {
      toast("Chronicle publishing requires the live admin database.", { description: "Sign in as the league admin with the backend enabled." });
      return;
    }
    setNewsBusy(true);
    try {
      await backendCreatePundit(input);
      await refreshRemoteDashboard();
      toast.success("Issue published", { description: "The new editorial is now live in The Khalpar Chronicle." });
    } catch (error) {
      toast.error("Issue could not be published", { description: error instanceof Error ? error.message : "Try again shortly." });
    } finally { setNewsBusy(false); }
  }

  async function deletePundit(id: string) {
    if (!isAdmin || !useBackend) return;
    if (!window.confirm("Delete this Chronicle issue? This cannot be undone.")) return;
    setNewsBusy(true);
    try {
      await backendDeletePundit(Number(id));
      await refreshRemoteDashboard();
      toast.success("Issue deleted", { description: "The editorial was removed from the Chronicle." });
    } catch (error) {
      toast.error("Issue could not be deleted", { description: error instanceof Error ? error.message : "Try again shortly." });
    } finally { setNewsBusy(false); }
  }

  async function archiveSeason() {
    if (!isAdmin || !useBackend) return;
    setNewsBusy(true);
    try {
      await backendCompleteSeason(database.league.id);
      await refreshRemoteDashboard();
      toast.success("Season archived", { description: "The standings, player statistics, team records, and newsroom facts are preserved for future seasons." });
    } catch (error) {
      toast.error("Season archive failed", { description: error instanceof Error ? error.message : "Finish and confirm every fixture first." });
    } finally { setNewsBusy(false); }
  }

  async function createNextSeason() {
    if (!isAdmin || !useBackend || database.league.status !== "COMPLETED") return;
    const suggestedName = `${database.league.name} · Season 2`;
    const name = window.prompt("Name the next league season", suggestedName)?.trim();
    if (!name) return;
    setNewsBusy(true);
    try {
      await backendCreateSeason(name);
      await refreshRemoteDashboard();
      toast.success("New season created", { description: `${name} is ready as a draft. Approve teams, then start its schedule.` });
    } catch (error) {
      toast.error("New season could not be created", { description: error instanceof Error ? error.message : "Try again shortly." });
    } finally { setNewsBusy(false); }
  }

  async function analyzeScorerReviews() {
    if (!isAdmin || !useBackend) return;
    const queuedIds = scorerReviews.filter((review) => review.status === "FAILED" || review.status === "PENDING").map((review) => review.id);
    if (!queuedIds.length) {
      toast("No queued scorer names", { description: "Suggestions already shown here are waiting for your approval." });
      return;
    }
    setScorerReviewBusy(true);
    let analyzed = 0;
    let failed = 0;
    const requestErrors: string[] = [];
    try {
      for (let offset = 0; offset < queuedIds.length; offset += 3) {
        const result = await backendAnalyzeScorerReviews(queuedIds.slice(offset, offset + 3));
        analyzed += result.analyzed;
        failed += result.failed;
        setScorerReviews(result.reviews || []);
      }
      if (failed) {
        toast.warning("Scorer analysis partly completed", { description: `${analyzed} suggestion${analyzed === 1 ? "" : "s"} ready for approval · ${failed} name${failed === 1 ? "" : "s"} can be retried.` });
      } else {
        toast.success("Scorer names analyzed", { description: `${analyzed} suggestion${analyzed === 1 ? "" : "s"} ready for your approval.` });
      }
    } catch (error) {
      requestErrors.push(error instanceof Error ? error.message : "Try again shortly.");
      toast.error("AI name review partly failed", { description: `${analyzed} names completed. ${requestErrors[0]}` });
    } finally {
      setScorerReviewBusy(false);
    }
  }

  async function approveScorerReview(reviewId: number, approvedName: string) {
    if (!isAdmin || !useBackend) return;
    try {
      await backendApproveScorerReview(reviewId, approvedName);
      await refreshRemoteDashboard();
      toast.success("Scorer name approved", { description: "The approved full name is now used for the official player record." });
    } catch (error) {
      toast.error("Scorer name could not be approved", { description: error instanceof Error ? error.message : "Try again." });
    }
  }

  async function rejectScorerReview(reviewId: number) {
    if (!isAdmin || !useBackend) return;
    try {
      await backendRejectScorerReview(reviewId);
      await refreshRemoteDashboard();
      toast("Suggestion rejected", { description: "The original submitted name remains unchanged." });
    } catch (error) {
      toast.error("Scorer suggestion could not be rejected", { description: error instanceof Error ? error.message : "Try again." });
    }
  }

  async function saveResult(matchId: string, homeScore: number, awayScore: number, goals: Goal[]) {
    if (!user) return;
    const match = database.matches.find((item) => item.id === matchId);
    if (!match) {
      toast.error("Fixture unavailable", { description: "That fixture is no longer in the live league database." });
      return;
    }
    if (!isMatchDateOpen(match)) {
      toast("Matchday is not open yet", { description: `This result opens from ${formatMatchDate(match.date)} in league time. The listed kickoff is ${formatMatchKickoff(match)}.` });
      return;
    }
    if (user.role !== "admin" && user.teamId !== match.homeTeamId) {
      toast("Home team entry only", { description: "Only the home team can submit the initial match data." });
      return;
    }
    if (!canSubmitMatch(user, match)) {
      toast.error("Result entry is unavailable", { description: "This fixture may already be official or awaiting review." });
      return;
    }
    try {
      if (useBackend) {
        await backendSubmitResult(matchId, homeScore, awayScore, goals);
        await refreshRemoteDashboard();
      } else {
        setDatabase((current) => {
          const nextMatch = { ...match, homeScore, awayScore, goals, status: "PENDING" as const, submittedBy: user.id, submittedAt: new Date().toISOString() };
          return { ...current, matches: current.matches.map((item) => item.id === matchId ? nextMatch : item), activities: [{ id: makeId("activity"), kind: "result" as const, title: `${user.name} submitted a result`, detail: `${matchLabel(current, nextMatch)} · awaiting admin confirmation`, time: "Just now" }, ...current.activities].slice(0, 5) };
        });
      }
      setResultMatchId(null);
      toast.success("Result saved", { description: "The result is pending admin confirmation." });
    } catch (error) {
      toast.error("Result could not be saved", { description: error instanceof Error ? error.message : "Try again." });
    }
  }

  async function confirmMatch(matchId: string) {
    if (!user || user.role !== "admin") {
      toast.error("Admin permission required", { description: "Only league admins can make a result official." });
      return;
    }
    try {
      if (useBackend) {
        await backendConfirmResult(matchId);
        await refreshRemoteDashboard();
      } else {
        setDatabase((current) => {
          const match = current.matches.find((item) => item.id === matchId);
          if (!match || !canConfirmMatch(user, match)) return current;
          return { ...current, matches: current.matches.map((item) => item.id === matchId ? { ...item, status: "CONFIRMED" } : item), activities: [{ id: makeId("activity"), kind: "update" as const, title: "Result confirmed", detail: `${matchLabel(current, match)} · table updated live`, time: "Just now" }, ...current.activities].slice(0, 5) };
        });
      }
      toast.success("Result confirmed", { description: "Standings and player stats are now official." });
    } catch (error) {
      toast.error("Result could not be confirmed", { description: error instanceof Error ? error.message : "Try again." });
    }
  }

  async function addTeam(name: string, shortName: string, manager: string) {
    if (!isAdmin) {
      toast.error("Admin permission required", { description: "Only admins can add teams to the league database." });
      return;
    }
    const accent = ["#9dd36a", "#79b9f2", "#bf9cf3", "#f1b664", "#f28d9d"][database.teams.length % 5];
    try {
      if (useBackend) {
        await backendCreateTeam(name, shortName, manager, accent);
        await refreshRemoteDashboard();
      } else {
        const team: Team = { id: makeId("team"), name, shortName, manager, accent };
        setDatabase((current) => ({ ...current, teams: [...current.teams, team], league: { ...current.league, teamsCount: current.teams.length + 1 }, activities: [{ id: makeId("activity"), kind: "update" as const, title: `${name} joined the league`, detail: `${manager} · ${shortName}`, time: "Just now" }, ...current.activities].slice(0, 5) }));
      }
      setShowTeamForm(false);
      toast.success(`${name} added`, { description: "The team record is saved. Generate fixtures when ready." });
    } catch (error) {
      toast.error("Team could not be added", { description: error instanceof Error ? error.message : "Try again." });
    }
  }

  async function updateTeam(teamId: string, name: string, shortCode: string) {
    if (!isAdmin) return;
    const team = database.teams.find((item) => item.id === teamId);
    if (!team) return;
    try {
      if (useBackend) {
        await backendUpdateTeam(teamId, name, shortCode);
        await refreshRemoteDashboard();
      } else {
        setDatabase((current) => ({
          ...current,
          teams: current.teams.map((item) => item.id === teamId ? { ...item, name, shortName: shortCode } : item),
        }));
      }
      setEditingTeamId(null);
      toast.success("Team details updated", { description: `${name} · ${shortCode} is now the official team identity.` });
    } catch (error) {
      toast.error("Team could not be updated", { description: error instanceof Error ? error.message : "Try a different team name or code." });
    }
  }

  async function deleteTeam(teamId: string) {
    if (!isAdmin) return;
    const team = database.teams.find((item) => item.id === teamId);
    if (!team) return;
    if (!window.confirm(`Delete ${team.name}? This cannot be undone.`)) return;
    try {
      if (useBackend) {
        await backendDeleteTeam(teamId);
        await refreshRemoteDashboard();
      } else {
        setDatabase((current) => ({ ...current, teams: current.teams.filter((item) => item.id !== teamId), users: current.users.map((item) => item.teamId === teamId ? { ...item, teamId: undefined } : item), league: { ...current.league, teamsCount: Math.max(current.teams.length - 1, 0) } }));
      }
      toast.success("Team deleted", { description: `${team.name} was removed from the live team directory.` });
    } catch (error) {
      toast.error("Team could not be deleted", { description: error instanceof Error ? error.message : "Teams with fixtures cannot be deleted." });
    }
  }

  async function decideTeam(teamId: string, decision: "approve" | "reject") {
    if (!isAdmin) return;
    try {
      if (useBackend) {
        await backendApproveTeam(teamId, decision);
        await refreshRemoteDashboard();
      } else {
        setDatabase((current) => ({ ...current, teams: current.teams.map((team) => team.id === teamId ? { ...team, approvalStatus: decision === "approve" ? "APPROVED" : "REJECTED" } : team) }));
      }
      toast.success(decision === "approve" ? "Team approved" : "Team rejected", { description: "The live team directory has been updated." });
    } catch (error) {
      toast.error("Team decision failed", { description: error instanceof Error ? error.message : "Try again." });
    }
  }

  async function startTournament() {
    if (!isAdmin) return;
    const seasonId = Number(database.league.id);
    const approvedTeamCount = database.teams.filter((team) => team.approvalStatus === "APPROVED").length;
    if (!useBackend || !Number.isFinite(seasonId)) {
      toast.error("Live season required", { description: "Start the tournament from the active league." });
      return;
    }
    if (approvedTeamCount < 2) {
      toast.error("Approve teams first", { description: "At least two approved teams are required before the tournament can start." });
      return;
    }
    try {
      const result = await backendStartTournament(seasonId);
      await refreshRemoteDashboard();
      toast.success("Tournament started", { description: `${result.fixturesCreated ? `${result.fixturesCreated} fixtures created · ` : "Existing fixtures activated · "}${result.matchdays} matchdays · ${result.matchesPerDay} matches per day.` });
    } catch (error) {
      toast.error("Tournament could not start", { description: error instanceof Error ? error.message : "Approve teams and try again." });
    }
  }

  async function resetTournament() {
    if (!isAdmin || !useBackend) {
      toast.error("Live admin access required", { description: "Only the league administrator can reset the live tournament." });
      return;
    }
    const seasonId = Number(database.league.id);
    if (!Number.isInteger(seasonId) || seasonId <= 0) {
      toast.error("Live season unavailable", { description: "The current league season could not be identified." });
      return;
    }
    const confirmed = window.confirm("RESET THE CURRENT TOURNAMENT?\n\nThis will permanently delete every fixture, score, goal, and pending result in the current season. Teams, player accounts, memberships, and the league season will be preserved so you can generate a new schedule.\n\nPress OK only if you want to restart the tournament.");
    if (!confirmed) return;
    try {
      const result = await backendResetTournament(seasonId);
      await refreshRemoteDashboard();
      toast.success("Tournament reset", { description: `${result.deletedMatches} fixture${result.deletedMatches === 1 ? "" : "s"} deleted. Teams and player accounts were preserved; you can start a new schedule.` });
    } catch (error) {
      toast.error("Tournament could not be reset", { description: error instanceof Error ? error.message : "Try again." });
    }
  }

  async function rescheduleMatch(matchId: string) {
    if (!isAdmin) return;
    const match = database.matches.find((item) => item.id === matchId);
    if (!match) return;
    const proposed = window.prompt("Enter the new kickoff date and time (for example: 2026-09-01 20:30)", `${match.date} 20:00`);
    if (!proposed) return;
    const kickoffAt = Date.parse(proposed.replace(" ", "T"));
    if (!Number.isFinite(kickoffAt) || kickoffAt <= Date.now()) {
      toast.error("Choose a future kickoff time", { description: "Use the format YYYY-MM-DD HH:MM." });
      return;
    }
    const reason = window.prompt("Why is this fixture being adjusted?", "Player availability") || "Fixture adjusted by league admin";
    try {
      if (useBackend) {
        await backendRescheduleMatch(matchId, kickoffAt, reason);
        await refreshRemoteDashboard();
      } else {
        setDatabase((current) => ({ ...current, matches: current.matches.map((item) => item.id === matchId ? { ...item, status: "POSTPONED" as const, originalKickoffAt: item.originalKickoffAt || item.date, date: new Date(kickoffAt).toISOString().slice(0, 10), rescheduledAt: new Date().toISOString(), rescheduleReason: reason } : item) }));
      }
      toast.success("Fixture postponed", { description: "The new kickoff time is visible in the fixture desk." });
    } catch (error) {
      toast.error("Fixture could not be adjusted", { description: error instanceof Error ? error.message : "Try again." });
    }
  }

  function resetDatabase() {
    setDatabase(createSeedDatabase());
    toast("Demo database restored", { description: "Seed fixtures, users, and permissions are back in place." });
  }

  function resetRules() {
    if (!isAdmin) return;
    setDatabase((current) => ({ ...current, tiebreakers: [...DEFAULT_TIEBREAKERS] }));
    toast.success("Tie-breakers reset", { description: "The official default order is active again." });
  }

  const approvedTeamCount = database.teams.filter((team) => team.approvalStatus === "APPROVED").length;
  const tournamentStarted = database.matches.length > 0;
  const seasonReadyToArchive = tournamentStarted && database.matches.every((match) => match.status === "CONFIRMED");
  const currentTitle = activeView === "overview" ? (userTeam?.name ? `${userTeam.name} matchday desk` : isAdmin ? "League command centre" : "League matchday desk") : activeView === "fixtures" ? "Fixtures & results" : activeView === "teams" ? "Teams & managers" : activeView === "table" ? "Live league table" : activeView === "chronicle" ? "The Khalpar Chronicle" : activeView === "database" ? "Database & access" : activeView === "league-tools" ? "League tools" : "Rules & tie-breakers";
  const currentDescription = activeView === "overview" ? (userTeam?.name ? `Your ${userTeam.name} view for matchday ${liveMatchday || "the current round"}: fixtures, results, and team progress in one place.` : "Keep the league moving with one clear place for every result, roster, and ranking.") : activeView === "fixtures" ? "Every scheduled match, submission, and confirmation in one calm workflow." : activeView === "teams" ? "Manage the clubs and eFootball accounts that power this season." : activeView === "table" ? "Official standings calculated from confirmed match results." : activeView === "chronicle" ? "The pulse of League'de Khalpar: signed editorials, verified facts, and the evidence behind the story." : activeView === "database" ? "Manage identity, role permissions, and the records behind this competition." : activeView === "league-tools" ? "Predictions, awards, head-to-head history, match evidence, notifications, and league integrations." : "Automated rules keep tied teams ordered without manual spreadsheet work.";

  if (user === undefined) return <div className="auth-shell"><div className="auth-card"><p className="eyebrow">SECURE LEAGUE ACCESS</p><h1>Checking your session…</h1><p className="auth-copy">Connecting to the league database.</p></div></div>;
  if (!user) return <LoginPanel database={database} onLogin={(nextUser) => { setRemoteUser(nextUser); handleLogin(nextUser); }} useBackend={useBackend} />;

  return (
    <div className={`league-app ${mobileNavOpen ? "mobile-nav-open" : ""}`}>
      <aside className="league-sidebar">
        <div className="league-brand"><span className="brand-ball"><span /></span><div><strong>eLeague<span>.</span></strong><small>matchday manager</small></div></div>
        <div className="league-selector"><span className="selector-mark">{initials(database.league.name)}</span><div><small>ACTIVE LEAGUE</small><strong>{database.league.name}</strong></div><ChevronDown size={15} /></div>
        <nav className="league-nav" aria-label="League navigation">
          <p className="nav-label">Workspace</p>
          <button className={activeView === "overview" ? "active" : ""} onClick={() => { setActiveView("overview"); setMobileNavOpen(false); }}><LayoutDashboard size={17} />Overview<span className="nav-shortcut">01</span></button>
          <button className={activeView === "fixtures" ? "active" : ""} onClick={() => { setActiveView("fixtures"); setMobileNavOpen(false); }}><CalendarDays size={17} />Fixtures<span className="nav-count">{pendingCount}</span></button>
          <button className={activeView === "table" ? "active" : ""} onClick={() => { setActiveView("table"); setMobileNavOpen(false); }}><Trophy size={17} />Standings</button>
          <button className={activeView === "teams" ? "active" : ""} onClick={() => { setActiveView("teams"); setMobileNavOpen(false); }}><Users size={17} />Teams</button>
          <button className={activeView === "chronicle" ? "active" : ""} onClick={() => { setActiveView("chronicle"); setMobileNavOpen(false); }}><Newspaper size={17} />Chronicle<span className="nav-shortcut">05</span></button>
           {isAdmin && <>
             <button className={activeView === "league-tools" ? "active" : ""} onClick={() => { setActiveView("league-tools"); setMobileNavOpen(false); }}><Sparkles size={17} />League tools<span className="nav-shortcut">06</span></button>
             <p className="nav-label nav-label-spaced">Admin tools</p>
           </>}
           {isAdmin && <>
            <button className={activeView === "database" ? "active" : ""} onClick={() => { setActiveView("database"); setMobileNavOpen(false); }}><Database size={17} />Database</button>
            <button className={activeView === "rules" ? "active" : ""} onClick={() => { setActiveView("rules"); setMobileNavOpen(false); }}><SlidersHorizontal size={17} />Rules</button>
          </>}
        </nav>
        <div className="sidebar-footer"><div className="sync-status"><span className="sync-dot" /><div><strong>All changes saved</strong><small>League records are up to date</small></div><RefreshCw size={14} /></div><button className="sidebar-user" onClick={signOut}><span className="user-avatar">{initials(user.name)}</span><span><strong>{user.name}</strong><small>{user.role === "admin" ? "League admin" : "Player account"}</small></span><LogOut size={16} /></button></div>
      </aside>

      <div className="league-main">
        <header className="league-topbar"><button className="mobile-menu" aria-label={mobileNavOpen ? "Close menu" : "Open menu"} aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((current) => !current)}><Menu size={20} /></button><div className="breadcrumbs"><span>{database.league.name}</span><ChevronRight size={14} /><strong>{activeView === "overview" ? "Overview" : currentTitle}</strong></div><div className="topbar-right"><span className={`role-badge role-${user.role}`}>{user.role === "admin" ? "Admin" : "Player"}</span><span className="live-indicator"><span />Live updates</span><button className="topbar-icon" aria-label="Search"><Search size={17} /></button><button className="topbar-icon" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} onClick={toggleTheme}>{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button><div className="topbar-notifications"><button className="topbar-icon" aria-label="Notifications" aria-expanded={notificationPanelOpen} aria-controls="notification-popover" onClick={() => setNotificationPanelOpen((current) => !current)}><Bell size={17} />{pendingCount > 0 && <span className="notification-dot" />}</button>{notificationPanelOpen && <div className="notification-popover" id="notification-popover" role="dialog" aria-label="League notifications"><div className="notification-popover-header"><div><span className="eyebrow">MATCHDAY SIGNALS</span><strong>{pendingCount ? `${pendingCount} result${pendingCount === 1 ? "" : "s"} need attention` : "You are all caught up"}</strong></div><button type="button" className="notification-popover-close" aria-label="Close notifications" onClick={() => setNotificationPanelOpen(false)}><X size={15} /></button></div>{pendingCount > 0 ? <button type="button" className="notification-popover-item" onClick={() => { setActiveView("fixtures"); setFixtureFilter("pending"); setNotificationPanelOpen(false); }}><span className="notification-popover-icon"><Clock3 size={15} /></span><span><strong>Review pending results</strong><small>Open the fixture desk to confirm provisional scores.</small></span><ArrowRight size={14} /></button> : <div className="notification-popover-empty"><ShieldCheck size={17} /><span>No pending results. New league activity will appear here.</span></div>}{todayMatches.slice(0, 3).map((match) => { const home = teamById(database.teams, match.homeTeamId); const away = teamById(database.teams, match.awayTeamId); return <button type="button" className="notification-popover-item" key={`notice-${match.id}`} onClick={() => { setActiveView("fixtures"); setNotificationPanelOpen(false); }}><span className="notification-popover-icon"><CalendarDays size={15} /></span><span><strong>{home?.shortName} vs {away?.shortName}</strong><small>Today · Matchday {match.matchday}</small></span><ArrowRight size={14} /></button>; })}</div>}</div><button className="topbar-user" onClick={signOut}><span className="user-avatar">{initials(user.name)}</span><ChevronDown size={14} /></button></div></header>
        <main className="league-content">
          <div className="page-intro"><div><p className="eyebrow">{database.league.season} <span className="intro-status"><span />{database.league.status}</span></p><h1>{currentTitle}</h1><p>{currentDescription}</p></div><div className="intro-actions"><Button variant="outline" onClick={() => setActiveView("fixtures")}><CalendarDays size={16} /> View fixtures</Button>{isAdmin && <Button onClick={() => openResult()}><Plus size={16} /> Submit result</Button>}</div></div>

          {activeView === "overview" && <>
            <div className="hero-grid"><section className="hero-card"><div className="hero-copy"><span className="hero-kicker"><span className="hero-live-dot" /> Matchday {liveMatchday || 1} in progress</span><h2>Keep the league<br /><em>moving forward.</em></h2><p>{pendingCount ? `${pendingCount} result is waiting for confirmation. Keep the official table clean with one quick review.` : "All results are up to date. The next fixture is ready when your players are."}</p><div className="hero-actions">{isAdmin && <Button onClick={() => openResult()}>{pendingCount ? "Review pending result" : "Enter next result"} <ArrowRight size={15} /></Button>}<button className="hero-text-action" onClick={() => setActiveView("fixtures")}>Open match centre <ArrowRight size={14} /></button></div></div><div className="hero-art" aria-hidden="true"><img src="/assets/football/league-hero.jpg" alt="" /></div></section><aside className="attention-card"><div className="attention-top"><span className="eyebrow">NEEDS YOUR ATTENTION</span><span className="attention-icon"><Bell size={16} /></span></div><strong>{pendingCount ? "One result is waiting" : "No reviews waiting"}</strong><p>{pendingMatch ? `${teamById(database.teams, pendingMatch.homeTeamId)?.name} submitted a ${pendingMatch.homeScore}–${pendingMatch.awayScore} result against ${teamById(database.teams, pendingMatch.awayTeamId)?.name}.` : "Your league is clear. New submissions will appear here."}</p>{pendingMatch && isAdmin ? <button onClick={() => confirmMatch(pendingMatch.id)}>Confirm result <Check size={15} /></button> : <span className="attention-clear"><ShieldCheck size={15} />{pendingMatch ? "Awaiting admin review" : "Everything is up to date"}</span>}</aside></div>
            <div className="metric-grid"><MetricCard label="Confirmed matches" value={`${confirmedCount} / ${database.matches.length}`} note={`${database.matches.length ? Math.round((confirmedCount / database.matches.length) * 100) : 0}% of the season complete`} accent="#9dd36a" icon={Check} /><MetricCard label="Pending confirmation" value={String(pendingCount).padStart(2, "0")} note="Review before the table updates" accent="#f0b35b" icon={Clock3} /><MetricCard label="Teams competing" value={String(database.teams.length).padStart(2, "0")} note="All manager records are assigned" accent="#79b9f2" icon={Users} /><MetricCard label="Database health" value="100%" note="No duplicate or missing records" accent="#bf9cf3" icon={Database} /></div>
            <div className="dashboard-grid"><section className="panel standings-panel"><div className="panel-header"><div><p className="eyebrow">01 / OFFICIAL TABLE</p><h2>Standings</h2></div><button className="panel-link" onClick={() => setActiveView("table")}>Full table <ArrowRight size={14} /></button></div><StandingTable standings={standings} compact /></section><section className="panel activity-panel"><div className="panel-header"><div><p className="eyebrow">02 / LIVE FEED</p><h2>Recent activity</h2></div><Activity size={18} className="panel-icon" /></div><ActivityFeed activities={database.activities} news={database.news || []} /></section></div>
            <TeamPerformancePanel performance={teamPerformance} />
            <LeagueSignalsPanel performance={teamPerformance} scorers={leaderboard(database)} />
            <section className="panel next-fixtures-panel"><div className="panel-header"><div><p className="eyebrow">03 / NEXT UP</p><h2>Fixture desk</h2></div><button className="panel-link" onClick={() => setActiveView("fixtures")}>See all {database.matches.length} fixtures <ArrowRight size={14} /></button></div><div className="next-fixtures-list">{database.matches.filter((match) => match.status !== "CONFIRMED").slice(0, 3).map((match) => <MatchRow key={match.id} database={database} match={match} user={user} isAdmin={isAdmin} onResult={openResult} onConfirm={confirmMatch} onReschedule={rescheduleMatch} onDetails={openMatchDetails} />)}</div></section>
          </>}

          {activeView === "league-tools" && <ProposedFeatureWorkspace database={database} user={user} isAdmin={isAdmin} seasonId={Number.isFinite(Number(database.league.id)) ? Number(database.league.id) : null} onOpenMatch={openMatchDetails} />}

          {activeView === "chronicle" && <>
            <KhalparChroniclePanel editorials={database.punditEditorials || []} standings={standings} isAdmin={Boolean(isAdmin)} seasonId={Number.isFinite(Number(database.league.id)) ? Number(database.league.id) : null} busy={newsBusy} onPublish={publishPundit} onDelete={deletePundit} />
            <NewsroomPanel news={database.news || []} archives={database.seasonArchives || []} isAdmin={Boolean(isAdmin)} seasonStatus={database.league.status} seasonReady={seasonReadyToArchive} onRefresh={refreshNewsroom} onArchive={archiveSeason} onCreateSeason={createNextSeason} busy={newsBusy} />
          </>}

          {activeView === "fixtures" && <section className="view-panel fixture-desk"><div className="fixture-desk-hero"><div><p className="eyebrow">THE MATCH CENTRE</p><h2>Fixtures, results & matchday rhythm</h2><p>See every league fixture at a glance. Your team’s matches are highlighted; every other result stays visible for the whole competition.</p></div><div className="fixture-desk-stats"><span><strong>{database.matches.length}</strong><small>total fixtures</small></span><span><strong>{confirmedCount}</strong><small>official results</small></span><span><strong>{ownedMatches.length}</strong><small>your fixtures</small></span></div></div><div className="fixture-legend"><span className="legend-item legend-owned"><i /> Your fixtures</span><span className="legend-item"><i /> Other league fixtures</span><span className="legend-note">Pending scores remain provisional until admin confirmation.</span></div><div className="fixture-layout"><div className="fixture-main"><div className="fixture-toolbar"><div className="fixture-toolbar-left"><div className="fixture-scope-tabs" role="tablist" aria-label="Fixture visibility"><button type="button" className={fixtureScope === "mine" ? "selected" : ""} onClick={() => setFixtureScope("mine")} disabled={!user.teamId} aria-pressed={fixtureScope === "mine"}>My fixtures <span>{ownedMatches.length}</span></button><button type="button" className={fixtureScope === "all" ? "selected" : ""} onClick={() => setFixtureScope("all")} aria-pressed={fixtureScope === "all"}>All fixtures <span>{database.matches.length}</span></button></div><div className="mobile-scroll-region filter-tabs-region"><div className="filter-tabs">{(["all", "upcoming", "pending", "completed"] as const).map((filter) => <button className={fixtureFilter === filter ? "selected" : ""} key={filter} onClick={() => setFixtureFilter(filter)}>{filter === "all" ? "All fixtures" : filter === "upcoming" ? "Upcoming" : filter === "pending" ? `Needs review ${pendingCount ? `· ${pendingCount}` : ""}` : "Completed"}</button>)}</div><span className="mobile-swipe-cue" aria-hidden="true">Swipe <ArrowRight size={12} /></span></div></div><label className="search-field"><Search size={15} /><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search teams" /></label></div><div className="fixture-jump-strip" aria-label="Jump to matchday"><button type="button" className={selectedMatchday === "all" ? "selected" : ""} onClick={() => setSelectedMatchday("all")}>All <span>{filteredMatches.length}</span></button>{groupedFixtures.map((group) => <button type="button" className={selectedMatchday === group.matchday ? "selected" : ""} key={group.matchday} onClick={() => { setSelectedMatchday(group.matchday); window.requestAnimationFrame(() => document.getElementById(`fixture-matchday-${group.matchday}`)?.scrollIntoView({ behavior: "smooth", block: "start" })); }}>MD{group.matchday} <span>{group.matches.length}</span></button>)}</div><div className="fixture-groups">{visibleFixtureGroups.length ? visibleFixtureGroups.map((group) => { const collapsed = !expandedMatchdays.includes(group.matchday) && group.matchday < liveMatchday && group.matches.every((match) => match.status === "CONFIRMED"); return <section className={`fixture-group ${collapsed ? "is-collapsed" : ""}`} id={`fixture-matchday-${group.matchday}`} key={group.matchday}><div className="fixture-group-heading"><span className="matchday-number">{String(group.matchday).padStart(2, "0")}</span><div><p className="eyebrow">MATCHDAY {group.matchday}</p><h2>{formatMatchDate(group.matches[0].date)}</h2></div><span className="fixture-group-count">{group.matches.length} matches</span><button type="button" className="fixture-collapse-toggle" aria-expanded={!collapsed} onClick={() => setExpandedMatchdays((current) => current.includes(group.matchday) ? current.filter((matchday) => matchday !== group.matchday) : [...current, group.matchday])}>{collapsed ? "Expand" : "Collapse"}</button></div>{!collapsed && group.matches.map((match) => <MatchRow key={match.id} database={database} match={match} user={user} isAdmin={isAdmin} onResult={openResult} onConfirm={confirmMatch} onReschedule={rescheduleMatch} onDetails={openMatchDetails} />)}</section>; }) : <Empty className="empty-panel"><EmptyHeader><EmptyMedia variant="icon"><CalendarDays size={20} /></EmptyMedia><EmptyTitle>No fixtures match this view</EmptyTitle><EmptyDescription>Try another status, matchday, or clear the team search.</EmptyDescription></EmptyHeader></Empty>}</div><button type="button" className="back-to-top" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><ArrowUp size={14} /> Back to top</button></div><aside className="today-fixtures-panel"><div className="today-panel-heading"><div><p className="eyebrow">LIVE TODAY</p><h3>Today’s fixtures</h3></div><CalendarDays size={18} /></div>{todayMatches.length ? <div className="today-fixtures-list">{todayMatches.map((match) => { const home = teamById(database.teams, match.homeTeamId); const away = teamById(database.teams, match.awayTeamId); const owned = isUserFixture(match, user); return <button type="button" className={`today-fixture ${owned ? "owned" : ""}`} key={match.id} onClick={() => setActiveView("fixtures")}><span className="today-fixture-time">{match.status === "CONFIRMED" ? "FT" : match.status === "PENDING" ? "PEN" : "—"}</span><span className="today-fixture-teams"><strong>{home?.shortName}</strong><span>{match.homeScore === null ? "vs" : `${match.homeScore} – ${match.awayScore}`}</span><strong>{away?.shortName}</strong></span><small>{owned ? "Your fixture" : `Matchday ${match.matchday}`}</small></button>; })}</div> : <div className="today-empty"><CalendarDays size={20} /><strong>No matches today</strong><span>The next matchday will appear here when it opens.</span></div>}<div className="today-panel-footer"><span><span className="today-live-dot" /> Live schedule</span><button type="button" onClick={() => setFixtureFilter("upcoming")}>View upcoming <ArrowRight size={13} /></button></div></aside></div></section>}

          {activeView === "teams" && <section className="view-panel"><div className="view-toolbar"><div><p className="eyebrow">ROSTER DIRECTORY</p><h2>{database.teams.length} teams in this season</h2><p className="section-caption">Only approved teams are included in generated fixtures.</p></div><div className="view-toolbar-actions">{isAdmin && <Button disabled={!useBackend || tournamentStarted || approvedTeamCount < 2} title={!useBackend ? "Live backend mode is required" : tournamentStarted ? "This tournament already has fixtures" : approvedTeamCount < 2 ? "Approve at least two teams first" : "Start the tournament and generate fixtures"} onClick={startTournament}><Flag size={16} /> {tournamentStarted ? "Tournament active" : "Start tournament"}</Button>}{isAdmin && useBackend && tournamentStarted && <Button variant="destructive" title="Delete the current fixtures and restart this tournament" onClick={resetTournament}><RefreshCw size={16} /> Reset tournament</Button>}{isAdmin ? <Button variant="outline" onClick={() => setShowTeamForm((current) => !current)}>{showTeamForm ? <X size={16} /> : <Plus size={16} />} {showTeamForm ? "Close form" : "Add team"}</Button> : <span className="read-only-note"><Eye size={14} /> Player view · read only</span>}</div></div>{isAdmin && database.teams.some((team) => team.approvalStatus === "PENDING") && <section className="approval-panel panel"><div className="panel-header"><div><p className="eyebrow">ADMIN QUEUE</p><h2>Teams awaiting approval</h2></div><Clock3 size={18} className="panel-icon" /></div><div className="approval-list">{database.teams.filter((team) => team.approvalStatus === "PENDING").map((team) => <div className="approval-row" key={team.id}><TeamMark team={team} size="sm" /><div><strong>{team.name}</strong><small>{team.manager} · {team.createdByEmail || "Registration request"}</small></div><div className="approval-actions"><Button onClick={() => decideTeam(team.id, "approve")}><Check size={14} /> Approve</Button><Button variant="outline" onClick={() => decideTeam(team.id, "reject")}><X size={14} /> Reject</Button></div></div>)}</div></section>}{showTeamForm && <AddTeamPanel onClose={() => setShowTeamForm(false)} onAdd={addTeam} />}{editingTeamId && (() => { const editTeam = database.teams.find((item) => item.id === editingTeamId); return editTeam ? <EditTeamPanel team={editTeam} onClose={() => setEditingTeamId(null)} onSave={(name, shortCode) => updateTeam(editingTeamId, name, shortCode)} /> : null; })()}<div className="team-grid">{database.teams.map((team, index) => { const row = standings.find((item) => item.id === team.id); const approval = team.approvalStatus || "APPROVED"; return <article className="team-card" key={team.id}><div className="team-card-top"><TeamMark team={team} size="lg" /><span className="team-card-rank">#{index + 1}</span>{isAdmin ? <div className="team-card-actions"><button className="icon-button" type="button" title={`Edit ${team.name}`} aria-label={`Edit ${team.name}`} onClick={() => setEditingTeamId(team.id)}><Pencil size={15} /></button><button className="icon-button danger-icon" type="button" title={`Delete ${team.name}`} aria-label={`Delete ${team.name}`} onClick={() => deleteTeam(team.id)}><Trash2 size={16} /></button></div> : <span className="team-card-rank-spacer" aria-hidden="true" />}</div><h3>{team.name}</h3><p><UserRound size={13} /> {team.manager}</p><span className={`team-approval approval-${approval.toLowerCase()}`}>{approval}</span><div className="team-card-stats"><span><strong>{row?.played ?? 0}</strong><small>played</small></span><span><strong>{row?.points ?? 0}</strong><small>points</small></span><span><strong>{row?.goalDifference && row.goalDifference > 0 ? `+${row.goalDifference}` : row?.goalDifference ?? 0}</strong><small>goal diff</small></span></div><div className="team-card-footer"><span className="team-record"><span className="record-dot" />{approval === "APPROVED" ? "Eligible for fixtures" : "Not in schedule yet"}</span><ArrowRight size={15} /></div></article>; })}</div></section>}

          {activeView === "table" && <section className="view-panel"><div className="table-view-grid"><section className="panel full-table-panel"><div className="panel-header"><div><p className="eyebrow">OFFICIAL STANDINGS</p><h2>{database.league.name} table</h2></div><span className="table-updated"><span />Updated live</span></div><StandingTable standings={standings} /></section><aside className="panel golden-boot-panel"><div className="panel-header"><div><p className="eyebrow">PLAYER STATS</p><h2>Golden Boot</h2></div><Trophy size={18} className="panel-icon" /></div><div className="scorer-list">{scorers.slice(0, 6).map((player, index) => <div className="scorer-row" key={`${player.teamId}-${player.playerEmail || player.name}`}><span className="scorer-rank">{String(index + 1).padStart(2, "0")}</span><div className="scorer-avatar">{initials(player.name)}</div><div><strong>{player.name}</strong><small>{player.teamName}</small></div><b>{player.goals}</b></div>)}{!scorers.length && <p className="muted-copy">Goal scorer data will appear after the first confirmed result.</p>}</div></aside></div><PlayerStatsPanel stats={playerStats} /></section>}

          {activeView === "database" && <DatabasePanel database={database} user={user} players={playerRegistry} onRenamePlayer={renamePlayer} playerRenameBusy={playerRenameBusy} scorerReviews={scorerReviews} onAnalyzeScorerReviews={analyzeScorerReviews} onApproveScorerReview={approveScorerReview} onRejectScorerReview={rejectScorerReview} scorerReviewBusy={scorerReviewBusy} onUpdateUser={updateUserAccount} userEditBusy={userEditBusy} notificationSnapshot={notificationSnapshot} onRefreshNotifications={refreshNotificationPreview} onSendNotifications={sendNotifications} notificationBusy={notificationBusy} notificationSending={notificationSending} />}
          {activeView === "rules" && <RulesPanel rules={database.tiebreakers} isAdmin={isAdmin} onReset={resetRules} />}
        </main>
        <footer className="league-footer"><span><Database size={14} /> Source of truth: confirmed matches</span><span>eLeague Manager · {database.league.season}</span>{useBackend ? <span>All changes saved</span> : isAdmin ? <button onClick={resetDatabase}>Reset demo data</button> : <span>Player view · protected</span>}</footer>
      </div>
      {resultMatchId && <ResultDrawer database={database} matchId={resultMatchId} playerStats={playerStats} useBackend={useBackend} onClose={() => setResultMatchId(null)} onSave={saveResult} />}
      {detailMatchId !== null && <MatchDetailsDrawer database={database} matchId={detailMatchId} user={user} isAdmin={isAdmin} onClose={() => setDetailMatchId(null)} />}
    </div>
  );
}
