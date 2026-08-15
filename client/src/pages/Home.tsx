import { Button } from "@/components/ui/button";
import {
  Activity,
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  BarChart3,
  Eye,
  KeyRound,
  ListChecks,
  LogOut,
  UserCog,
  Clock3,
  Database,
  Flag,
  LayoutDashboard,
  Menu,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trophy,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  authenticateUser,
  calculateStandings,
  createSeedDatabase,
  DEFAULT_TIEBREAKERS,
  canConfirmMatch,
  canSubmitMatch,
  countConfirmed,
  countPending,
  formatMatchDate,
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
  type Goal,
  type LeagueDatabase,
  type Match,
  type PlayerStat,
  type Standing,
  type Team,
  type TiebreakerRule,
  type UserAccount,
} from "@/lib/league-db";
import { backendConfirmResult, backendCreateTeam, backendDashboard, backendEnabled, backendGenerateSchedule, backendLogin, backendLogout, backendMe, backendSubmitResult, mergeBackendDashboard, toLocalUser } from "@/lib/backend-api";

type View = "overview" | "fixtures" | "teams" | "table" | "database" | "rules";
type ResultInput = { id: string; teamId: string; playerName: string; minute: string };

function initials(value: string) {
  return value.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function statusLabel(status: Match["status"]) {
  if (status === "CONFIRMED") return "Confirmed";
  if (status === "PENDING") return "Awaiting confirmation";
  if (status === "DISPUTED") return "Needs review";
  return "Scheduled";
}

function statusClass(status: Match["status"]) {
  return status.toLowerCase();
}

function shortDay(date: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(new Date(`${date}T12:00:00`));
}

function TeamMark({ team, size = "md" }: { team?: Team; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`team-mark team-mark-${size}`} style={{ "--team-accent": team?.accent ?? "#b2b9bc" } as React.CSSProperties}>
      {team ? initials(team.name) : "??"}
    </span>
  );
}

function MetricCard({ label, value, note, accent, icon: Icon }: { label: string; value: string; note: string; accent: string; icon: typeof Database }) {
  return (
    <article className="metric-card" style={{ "--metric-accent": accent } as React.CSSProperties}>
      <div className="metric-card-top"><span className="metric-card-label">{label}</span><Icon size={17} strokeWidth={1.8} /></div>
      <strong>{value}</strong>
      <span className="metric-card-note">{note}</span>
    </article>
  );
}

function FormPill({ value }: { value: "W" | "D" | "L" }) {
  return <span className={`form-pill form-${value.toLowerCase()}`}>{value}</span>;
}

function MatchRow({ database, match, isAdmin, onResult, onConfirm }: { database: LeagueDatabase; match: Match; isAdmin: boolean; onResult: (id: string) => void; onConfirm: (id: string) => void }) {
  const home = teamById(database.teams, match.homeTeamId);
  const away = teamById(database.teams, match.awayTeamId);
  const canConfirm = isAdmin && match.status === "PENDING";
  return (
    <article className="match-row">
      <div className="match-date"><span>{shortDay(match.date)}</span><strong>{formatMatchDate(match.date)}</strong><small>Matchday {match.matchday}</small></div>
      <div className="match-teams">
        <div className="match-team home"><span>{home?.name}</span><TeamMark team={home} size="sm" /></div>
        <div className="match-score">
          {match.homeScore === null ? <span className="vs">VS</span> : <strong>{match.homeScore} <i>–</i> {match.awayScore}</strong>}
        </div>
        <div className="match-team away"><TeamMark team={away} size="sm" /><span>{away?.name}</span></div>
      </div>
      <div className="match-meta"><span className={`status-chip ${statusClass(match.status)}`}><span />{statusLabel(match.status)}</span><small>{match.goals.length ? `${match.goals.length} goal${match.goals.length === 1 ? "" : "s"} logged` : "No result yet"}</small></div>
      <div className="match-actions">
        {canConfirm && <button className="confirm-link" onClick={() => onConfirm(match.id)}><Check size={14} /> Confirm</button>}
        <button className="row-action" onClick={() => onResult(match.id)}>{match.status === "SCHEDULED" ? "Enter result" : "View result"}<ArrowRight size={14} /></button>
      </div>
    </article>
  );
}

function StandingTable({ standings, compact = false }: { standings: Standing[]; compact?: boolean }) {
  const rows = compact ? standings.slice(0, 5) : standings;
  return (
    <div className="table-wrap">
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
      {compact && <p className="table-footnote">Live table · sorted by points, goal difference, then goals scored <ArrowRight size={14} /></p>}
    </div>
  );
}

function ActivityFeed({ activities }: { activities: LeagueActivity[] }) {
  return (
    <div className="activity-feed">
      {!activities.length && <p className="muted-copy">No database activity yet. Confirmed results and admin actions will appear here.</p>}
      {activities.map((activity) => (
        <article className="activity-item" key={activity.id}>
          <span className={`activity-icon activity-${activity.kind}`}>{activity.kind === "result" ? <ClipboardList size={15} /> : activity.kind === "leaderboard" ? <Trophy size={15} /> : <Sparkles size={15} />}</span>
          <div><strong>{activity.title}</strong><p>{activity.detail}</p></div>
          <time>{activity.time}</time>
        </article>
      ))}
    </div>
  );
}

function LoginPanel({ database, onLogin, useBackend }: { database: LeagueDatabase; onLogin: (user: UserAccount) => void; useBackend: boolean }) {
  const [email, setEmail] = useState(useBackend ? "" : "alex@eleague.local");
  const [passcode, setPasscode] = useState(useBackend ? "" : "admin123");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (useBackend) {
        const result = await backendLogin(email, passcode);
        onLogin(toLocalUser(result.user));
        toast.success(`Welcome back, ${result.user.displayName.split(" ")[0]}`, { description: result.user.role === "admin" ? "Admin permissions are active." : "Player permissions are active." });
      } else {
        const user = authenticateUser(database, email, passcode);
        if (!user) throw new Error("Check the league email and passcode, then try again.");
        onLogin(user);
        toast.success(`Welcome back, ${user.name.split(" ")[0]}`, { description: user.role === "admin" ? "Admin permissions are active." : "Player permissions are active." });
      }
    } catch (error) {
      toast.error("Sign-in failed", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      setBusy(false);
    }
  }
  return <div className="auth-shell"><div className="auth-card"><div className="league-brand auth-brand"><span className="brand-ball"><span /></span><div><strong>eLeague<span>.</span></strong><small>matchday manager</small></div></div><p className="eyebrow">SECURE LEAGUE ACCESS</p><h1>Sign in to matchday.</h1><p className="auth-copy">Your role controls what you can change. Admins manage the competition; players submit results for their own fixtures.</p><form className="auth-form" onSubmit={submit}><label>League email<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" autoComplete="current-password" required value={passcode} onChange={(event) => setPasscode(event.target.value)} /></label><Button type="submit" disabled={busy}><KeyRound size={16} /> {busy ? "Checking access…" : "Sign in"}</Button></form>{useBackend ? <div className="demo-access"><strong>Database access is active</strong><span>Use the email and password created by your league administrator.</span></div> : <div className="demo-access"><strong>Demo access</strong><span>Admin · alex@eleague.local / admin123</span><span>Player · sam@eleague.local / player123</span></div>}</div></div>;
}

function PlayerStatsPanel({ stats }: { stats: PlayerStat[] }) {
  return <section className="panel stats-panel"><div className="panel-header"><div><p className="eyebrow">LIVE PLAYER INTELLIGENCE</p><h2>Form & scoring</h2></div><BarChart3 size={18} className="panel-icon" /></div><div className="player-stat-grid">{stats.slice(0, 8).map((player, index) => <article className="player-stat-card" key={`${player.teamId}-${player.name}`}><div className="player-stat-heading"><span className="scorer-rank">{String(index + 1).padStart(2, "0")}</span><div className="scorer-avatar">{initials(player.name)}</div><div><strong>{player.name}</strong><small>{player.teamName}</small></div></div><div className="player-stat-metrics"><span><b>{player.officialGoals}</b><small>official</small></span><span><b>{player.pendingGoals}</b><small>pending</small></span><span><b>{player.appearances}</b><small>matches</small></span><span><b>{player.averageMinute || "—"}</b><small>avg min</small></span></div></article>)}{!stats.length && <p className="muted-copy">Player data will appear as scorers are logged.</p>}</div><p className="table-footnote"><Eye size={14} /> Pending goals are visible immediately but only confirmed goals count toward the official Golden Boot.</p></section>;
}

function DatabasePanel({ database, user }: { database: LeagueDatabase; user: UserAccount }) {
  return <section className="view-panel"><div className="database-hero"><div><p className="eyebrow">DATABASE CONTROL CENTER</p><h2>Identity, access & records</h2><p>All league records are typed, permission-aware, and loaded from the live TiDB database.</p></div><span className="health-badge"><span /> Schema healthy</span></div><div className="database-grid"><article className="panel database-card"><div className="panel-header"><div><p className="eyebrow">ACCESS DIRECTORY</p><h2>{database.users.length} accounts</h2></div><UserCog size={18} className="panel-icon" /></div><div className="user-directory">{database.users.map((account) => { const team = account.teamId ? teamById(database.teams, account.teamId) : undefined; return <div className="user-directory-row" key={account.id}><span className="user-avatar">{initials(account.name)}</span><div><strong>{account.name}</strong><small>{account.email}{team ? ` · ${team.name}` : " · Competition-wide"}</small></div><span className={`role-badge role-${account.role}`}>{account.role}</span></div>; })}</div><p className="permission-note"><ShieldCheck size={14} /> You are signed in as <strong>{user.name}</strong>. {user.role === "admin" ? "Admin actions are unlocked." : "Player actions are limited to assigned fixtures."}</p></article><article className="panel database-card"><div className="panel-header"><div><p className="eyebrow">RECORD COUNTS</p><h2>Source of truth</h2></div><Database size={18} className="panel-icon" /></div><div className="record-counts"><div><strong>{database.teams.length}</strong><span>teams</span></div><div><strong>{database.matches.length}</strong><span>fixtures</span></div><div><strong>{database.matches.filter((match) => match.status === "CONFIRMED").length}</strong><span>official results</span></div><div><strong>{database.users.length}</strong><span>users</span></div></div><p className="muted-copy">This dashboard is connected to the production database. Empty sections mean records have not been created yet.</p></article></div></section>;
}

function RulesPanel({ rules, isAdmin, onReset }: { rules: TiebreakerRule[]; isAdmin: boolean; onReset: () => void }) {
  return <section className="view-panel"><div className="database-hero"><div><p className="eyebrow">COMPETITION RULES</p><h2>Automated tie-breakers</h2><p>Standings resolve equal points in this order, automatically after every confirmation.</p></div><span className="health-badge"><ListChecks size={14} /> Live calculation</span></div><div className="rules-card panel"><div className="rule-list">{rules.map((rule, index) => <div className="rule-row" key={rule}><span className="rule-number">{index + 1}</span><div><strong>{ruleLabel(rule)}</strong><small>{rule === "points" ? "3 for a win · 1 for a draw" : rule === "goalDifference" ? "Goals scored minus goals conceded" : rule === "goalsFor" ? "Total goals scored" : rule === "headToHead" ? "Points earned in direct meetings" : "Number of wins"}</small></div><span className="rule-status">Automatic</span></div>)}</div><div className="rule-footer"><span><ShieldCheck size={15} /> Standings update only from confirmed results.</span>{isAdmin ? <Button variant="outline" onClick={onReset}>Reset default order</Button> : <small>Admin only · rule configuration</small>}</div></div></section>;
}

function ResultDrawer({ database, matchId, playerStats, onClose, onSave }: { database: LeagueDatabase; matchId: string; playerStats: PlayerStat[]; onClose: () => void; onSave: (matchId: string, homeScore: number, awayScore: number, goals: Goal[]) => void }) {
  const match = database.matches.find((item) => item.id === matchId);
  const home = match ? teamById(database.teams, match.homeTeamId) : undefined;
  const away = match ? teamById(database.teams, match.awayTeamId) : undefined;
  const liveStats = playerStats.filter((player) => player.teamId === match?.homeTeamId || player.teamId === match?.awayTeamId);
  const [homeScore, setHomeScore] = useState(match?.homeScore?.toString() ?? "");
  const [awayScore, setAwayScore] = useState(match?.awayScore?.toString() ?? "");
  const [scorers, setScorers] = useState<ResultInput[]>(() => (match?.goals ?? []).map((goal) => ({ id: goal.id, teamId: goal.teamId, playerName: goal.playerName, minute: String(goal.minute) })));

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
    const goals = scorers.filter((goal) => goal.playerName.trim()).map((goal) => ({ id: goal.id, teamId: goal.teamId, playerName: goal.playerName.trim(), minute: Number(goal.minute) || 0 }));
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
          <div className="drawer-live-stats"><div><p className="eyebrow">LIVE PLAYER STATS</p><strong>Use recent form to log scorers faster.</strong></div><div className="drawer-stat-list">{liveStats.slice(0, 4).map((player) => <span key={`${player.teamId}-${player.name}`}><b>{player.name}</b><small>{player.officialGoals} official · {player.pendingGoals} pending · avg {player.averageMinute || "—"}′</small></span>)}{!liveStats.length && <small>No scorer history for these teams yet.</small>}</div></div>
          <div className="drawer-section-heading"><div><p className="eyebrow">GOAL LOG</p><h3>Who found the net?</h3></div><span className="goal-counter">{loggedGoals} / {totalGoals} logged</span></div>
          {missingGoals > 0 && <div className="drawer-hint"><CircleHelp size={15} /><span>{missingGoals} goal{missingGoals === 1 ? "" : "s"} still need a scorer. You can add the details now or save the score and complete them later.</span></div>}
          <div className="goal-log">
            {scorers.length === 0 && <div className="goal-empty"><Trophy size={18} /><span>Adding scorers keeps the Golden Boot accurate.</span></div>}
            {scorers.map((goal, index) => (
              <div className="goal-row" key={goal.id}>
                <span className="goal-index">{String(index + 1).padStart(2, "0")}</span>
                <select aria-label={`Goal ${index + 1} team`} value={goal.teamId} onChange={(event) => updateGoal(goal.id, "teamId", event.target.value)}><option value={home.id}>{home.shortName}</option><option value={away.id}>{away.shortName}</option></select>
                <input aria-label={`Goal ${index + 1} scorer`} value={goal.playerName} onChange={(event) => updateGoal(goal.id, "playerName", event.target.value)} placeholder="Player name" />
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

export default function Home() {
  const [database, setDatabase] = useState<LeagueDatabase>(() => getDatabase());
  const [remoteUser, setRemoteUser] = useState<UserAccount | null | undefined>(undefined);
  const [activeView, setActiveView] = useState<View>("overview");
  const [resultMatchId, setResultMatchId] = useState<string | null>(null);
  const [showTeamForm, setShowTeamForm] = useState(false);
  const [fixtureFilter, setFixtureFilter] = useState<"all" | "upcoming" | "pending" | "completed">("all");
  const [searchTerm, setSearchTerm] = useState("");

  const useBackend = backendEnabled();
  useEffect(() => saveDatabase(database), [database]);
  useEffect(() => {
    if (!useBackend) {
      setRemoteUser(null);
      return;
    }
    backendMe().then((result) => setRemoteUser(result ? toLocalUser(result) : null));
  }, [useBackend]);
  useEffect(() => {
    if (!useBackend || !remoteUser) return;
    backendDashboard().then((snapshot) => setDatabase((current) => mergeBackendDashboard(current, snapshot))).catch((error) => toast.error("Could not load league data", { description: error instanceof Error ? error.message : "Try again shortly." }));
  }, [useBackend, remoteUser?.id]);

  const user = useBackend ? remoteUser : getCurrentUser(database);
  const isAdmin = user?.role === "admin";
  const standings = useMemo(() => calculateStandings(database), [database]);
  const scorers = useMemo(() => leaderboard(database), [database]);
  const playerStats = useMemo(() => livePlayerStats(database), [database]);
  const confirmedCount = countConfirmed(database);
  const pendingCount = countPending(database);
  const nextMatch = database.matches.find((match) => match.status === "SCHEDULED");
  const pendingMatch = database.matches.find((match) => match.status === "PENDING");
  const filteredMatches = useMemo(() => database.matches.filter((match) => {
    const statusMatch = fixtureFilter === "all" || (fixtureFilter === "upcoming" && match.status === "SCHEDULED") || (fixtureFilter === "pending" && (match.status === "PENDING" || match.status === "DISPUTED")) || (fixtureFilter === "completed" && match.status === "CONFIRMED");
    const home = teamById(database.teams, match.homeTeamId)?.name.toLowerCase() ?? "";
    const away = teamById(database.teams, match.awayTeamId)?.name.toLowerCase() ?? "";
    return statusMatch && (!searchTerm || home.includes(searchTerm.toLowerCase()) || away.includes(searchTerm.toLowerCase()));
  }), [database, fixtureFilter, searchTerm]);
  const groupedFixtures = useMemo(() => Array.from(new Set(filteredMatches.map((match) => match.matchday))).map((matchday) => ({ matchday, matches: filteredMatches.filter((match) => match.matchday === matchday) })), [filteredMatches]);

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
    const id = matchId ?? pendingMatch?.id ?? nextMatch?.id;
    if (!id) {
      toast("Every fixture already has a result.", { description: "The league is ready for the next season." });
      return;
    }
    const match = database.matches.find((item) => item.id === id);
    if (!user || !match || !canSubmitMatch(user, match)) {
      toast.error("You cannot submit this fixture", { description: "Players can only submit results involving their assigned team." });
      return;
    }
    setResultMatchId(id);
  }

  async function refreshRemoteDashboard() {
    if (!useBackend) return;
    const snapshot = await backendDashboard();
    setDatabase((current) => mergeBackendDashboard(current, snapshot));
  }

  async function saveResult(matchId: string, homeScore: number, awayScore: number, goals: Goal[]) {
    if (!user) return;
    const match = database.matches.find((item) => item.id === matchId);
    if (!match || !canSubmitMatch(user, match)) return;
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

  function resetDatabase() {
    setDatabase(createSeedDatabase());
    toast("Demo database restored", { description: "Seed fixtures, users, and permissions are back in place." });
  }

  function resetRules() {
    if (!isAdmin) return;
    setDatabase((current) => ({ ...current, tiebreakers: [...DEFAULT_TIEBREAKERS] }));
    toast.success("Tie-breakers reset", { description: "The official default order is active again." });
  }

  const currentTitle = activeView === "overview" ? `Good afternoon, ${user?.name.split(" ")[0] ?? "there"}` : activeView === "fixtures" ? "Fixtures & results" : activeView === "teams" ? "Teams & managers" : activeView === "table" ? "Live league table" : activeView === "database" ? "Database & access" : "Rules & tie-breakers";
  const currentDescription = activeView === "overview" ? "Keep the league moving with one clear place for every result, roster, and ranking." : activeView === "fixtures" ? "Every scheduled match, submission, and confirmation in one calm workflow." : activeView === "teams" ? "Manage the clubs and eFootball accounts that power this season." : activeView === "table" ? "Official standings calculated from confirmed match results." : activeView === "database" ? "Manage identity, role permissions, and the records behind this competition." : "Automated rules keep tied teams ordered without manual spreadsheet work.";

  if (user === undefined) return <div className="auth-shell"><div className="auth-card"><p className="eyebrow">SECURE LEAGUE ACCESS</p><h1>Checking your session…</h1><p className="auth-copy">Connecting to the league database.</p></div></div>;
  if (!user) return <LoginPanel database={database} onLogin={(nextUser) => { setRemoteUser(nextUser); handleLogin(nextUser); }} useBackend={useBackend} />;

  return (
    <div className="league-app">
      <aside className="league-sidebar">
        <div className="league-brand"><span className="brand-ball"><span /></span><div><strong>eLeague<span>.</span></strong><small>matchday manager</small></div></div>
        <div className="league-selector"><span className="selector-mark">{initials(database.league.name)}</span><div><small>ACTIVE LEAGUE</small><strong>{database.league.name}</strong></div><ChevronDown size={15} /></div>
        <nav className="league-nav" aria-label="League navigation">
          <p className="nav-label">Workspace</p>
          <button className={activeView === "overview" ? "active" : ""} onClick={() => setActiveView("overview")}><LayoutDashboard size={17} />Overview<span className="nav-shortcut">01</span></button>
          <button className={activeView === "fixtures" ? "active" : ""} onClick={() => setActiveView("fixtures")}><CalendarDays size={17} />Fixtures<span className="nav-count">{pendingCount}</span></button>
          <button className={activeView === "table" ? "active" : ""} onClick={() => setActiveView("table")}><Trophy size={17} />Standings</button>
          <button className={activeView === "teams" ? "active" : ""} onClick={() => setActiveView("teams")}><Users size={17} />Teams</button>
          <p className="nav-label nav-label-spaced">League tools</p>
          {isAdmin && <>
            <button className={activeView === "database" ? "active" : ""} onClick={() => setActiveView("database")}><Database size={17} />Database<span className="nav-live">LIVE</span></button>
            <button className={activeView === "rules" ? "active" : ""} onClick={() => setActiveView("rules")}><SlidersHorizontal size={17} />Rules</button>
          </>}
        </nav>
        <div className="sidebar-footer"><div className="sync-status"><span className="sync-dot" /><div><strong>Live database</strong><small>Connected to TiDB · just now</small></div><RefreshCw size={14} /></div><button className="sidebar-user" onClick={signOut}><span className="user-avatar">{initials(user.name)}</span><span><strong>{user.name}</strong><small>{user.role === "admin" ? "League admin" : "Player account"}</small></span><LogOut size={16} /></button></div>
      </aside>

      <div className="league-main">
        <header className="league-topbar"><button className="mobile-menu" aria-label="Open menu"><Menu size={20} /></button><div className="breadcrumbs"><span>{database.league.name}</span><ChevronRight size={14} /><strong>{activeView === "overview" ? "Overview" : currentTitle}</strong></div><div className="topbar-right"><span className={`role-badge role-${user.role}`}>{user.role === "admin" ? "Admin" : "Player"}</span><span className="live-indicator"><span />Live updates</span><button className="topbar-icon" aria-label="Search"><Search size={17} /></button><button className="topbar-icon" aria-label="Notifications" onClick={() => toast(pendingCount ? `${pendingCount} result needs attention` : "You are all caught up") }><Bell size={17} />{pendingCount > 0 && <span className="notification-dot" />}</button><button className="topbar-user" onClick={signOut}><span className="user-avatar">{initials(user.name)}</span><ChevronDown size={14} /></button></div></header>
        <main className="league-content">
          <div className="page-intro"><div><p className="eyebrow">{database.league.season} <span className="intro-status"><span />{database.league.status}</span></p><h1>{currentTitle}</h1><p>{currentDescription}</p></div><div className="intro-actions"><Button variant="outline" onClick={() => setActiveView("fixtures")}><CalendarDays size={16} /> View fixtures</Button><Button onClick={() => openResult()}><Plus size={16} /> Submit result</Button></div></div>

          {activeView === "overview" && <>
            <div className="hero-grid"><section className="hero-card"><div className="hero-copy"><span className="hero-kicker"><span className="hero-live-dot" /> Matchday {database.matches[0]?.matchday ?? 1} in progress</span><h2>Keep the league<br /><em>moving forward.</em></h2><p>{pendingCount ? `${pendingCount} result is waiting for confirmation. Keep the official table clean with one quick review.` : "All results are up to date. The next fixture is ready when your players are."}</p><div className="hero-actions"><Button onClick={() => openResult()}>{pendingCount ? "Review pending result" : "Enter next result"} <ArrowRight size={15} /></Button><button className="hero-text-action" onClick={() => setActiveView("fixtures")}>Open match centre <ArrowRight size={14} /></button></div></div><div className="pitch-art" aria-hidden="true"><div className="pitch-line pitch-midline" /><div className="pitch-circle" /><div className="pitch-box pitch-box-top" /><div className="pitch-box pitch-box-bottom" /><span className="pitch-player player-one" /><span className="pitch-player player-two" /><span className="pitch-player player-three" /><span className="pitch-player player-four" /></div></section><aside className="attention-card"><div className="attention-top"><span className="eyebrow">NEEDS YOUR ATTENTION</span><span className="attention-icon"><Bell size={16} /></span></div><strong>{pendingCount ? "One result is waiting" : "No reviews waiting"}</strong><p>{pendingMatch ? `${teamById(database.teams, pendingMatch.homeTeamId)?.name} submitted a ${pendingMatch.homeScore}–${pendingMatch.awayScore} result against ${teamById(database.teams, pendingMatch.awayTeamId)?.name}.` : "Your league is clear. New submissions will appear here."}</p>{pendingMatch && isAdmin ? <button onClick={() => confirmMatch(pendingMatch.id)}>Confirm result <Check size={15} /></button> : <span className="attention-clear"><ShieldCheck size={15} />{pendingMatch ? "Awaiting admin review" : "Everything is up to date"}</span>}</aside></div>
            <div className="metric-grid"><MetricCard label="Confirmed matches" value={`${confirmedCount} / ${database.matches.length}`} note={`${database.matches.length ? Math.round((confirmedCount / database.matches.length) * 100) : 0}% of the season complete`} accent="#9dd36a" icon={Check} /><MetricCard label="Pending confirmation" value={String(pendingCount).padStart(2, "0")} note="Review before the table updates" accent="#f0b35b" icon={Clock3} /><MetricCard label="Teams competing" value={String(database.teams.length).padStart(2, "0")} note="All manager records are assigned" accent="#79b9f2" icon={Users} /><MetricCard label="Database health" value="100%" note="No duplicate or missing records" accent="#bf9cf3" icon={Database} /></div>
            <div className="dashboard-grid"><section className="panel standings-panel"><div className="panel-header"><div><p className="eyebrow">01 / OFFICIAL TABLE</p><h2>Standings</h2></div><button className="panel-link" onClick={() => setActiveView("table")}>Full table <ArrowRight size={14} /></button></div><StandingTable standings={standings} compact /></section><section className="panel activity-panel"><div className="panel-header"><div><p className="eyebrow">02 / LIVE FEED</p><h2>Recent activity</h2></div><Activity size={18} className="panel-icon" /></div><ActivityFeed activities={database.activities} /></section></div>
            <section className="panel next-fixtures-panel"><div className="panel-header"><div><p className="eyebrow">03 / NEXT UP</p><h2>Fixture desk</h2></div><button className="panel-link" onClick={() => setActiveView("fixtures")}>See all {database.matches.length} fixtures <ArrowRight size={14} /></button></div><div className="next-fixtures-list">{database.matches.filter((match) => match.status !== "CONFIRMED").slice(0, 3).map((match) => <MatchRow key={match.id} database={database} match={match} isAdmin={isAdmin} onResult={openResult} onConfirm={confirmMatch} />)}</div></section>
          </>}

          {activeView === "fixtures" && <section className="view-panel"><div className="fixture-toolbar"><div className="filter-tabs">{(["all", "upcoming", "pending", "completed"] as const).map((filter) => <button className={fixtureFilter === filter ? "selected" : ""} key={filter} onClick={() => setFixtureFilter(filter)}>{filter === "all" ? "All fixtures" : filter === "upcoming" ? "Upcoming" : filter === "pending" ? `Needs review ${pendingCount ? `· ${pendingCount}` : ""}` : "Completed"}</button>)}</div><label className="search-field"><Search size={15} /><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search teams" /></label></div><div className="fixture-groups">{groupedFixtures.length ? groupedFixtures.map((group) => <section className="fixture-group" key={group.matchday}><div className="fixture-group-heading"><span className="matchday-number">{String(group.matchday).padStart(2, "0")}</span><div><p className="eyebrow">MATCHDAY {group.matchday}</p><h2>{formatMatchDate(group.matches[0].date)}</h2></div><span className="fixture-group-count">{group.matches.length} matches</span></div>{group.matches.map((match) => <MatchRow key={match.id} database={database} match={match} isAdmin={isAdmin} onResult={openResult} onConfirm={confirmMatch} />)}</section>) : <div className="empty-panel"><CalendarDays size={24} /><h3>No fixtures match this view.</h3><p>Try a different status or clear the team search.</p></div>}</div></section>}

          {activeView === "teams" && <section className="view-panel"><div className="view-toolbar"><div><p className="eyebrow">ROSTER DIRECTORY</p><h2>{database.teams.length} teams in this season</h2></div>{isAdmin ? <Button onClick={() => setShowTeamForm((current) => !current)}>{showTeamForm ? <X size={16} /> : <Plus size={16} />} {showTeamForm ? "Close form" : "Add team"}</Button> : <span className="read-only-note"><Eye size={14} /> Player view · read only</span>}</div>{showTeamForm && <AddTeamPanel onClose={() => setShowTeamForm(false)} onAdd={addTeam} />}<div className="team-grid">{database.teams.map((team, index) => { const row = standings.find((item) => item.id === team.id); return <article className="team-card" key={team.id}><div className="team-card-top"><TeamMark team={team} size="lg" /><span className="team-card-rank">#{index + 1}</span><button className="icon-button"><MoreHorizontal size={17} /></button></div><h3>{team.name}</h3><p><UserRound size={13} /> {team.manager}</p><div className="team-card-stats"><span><strong>{row?.played ?? 0}</strong><small>played</small></span><span><strong>{row?.points ?? 0}</strong><small>points</small></span><span><strong>{row?.goalDifference && row.goalDifference > 0 ? `+${row.goalDifference}` : row?.goalDifference ?? 0}</strong><small>goal diff</small></span></div><div className="team-card-footer"><span className="team-record"><span className="record-dot" />Database record active</span><ArrowRight size={15} /></div></article>; })}</div></section>}

          {activeView === "table" && <section className="view-panel"><div className="table-view-grid"><section className="panel full-table-panel"><div className="panel-header"><div><p className="eyebrow">OFFICIAL STANDINGS</p><h2>River City eLeague table</h2></div><span className="table-updated"><span />Updated live</span></div><StandingTable standings={standings} /></section><aside className="panel golden-boot-panel"><div className="panel-header"><div><p className="eyebrow">PLAYER STATS</p><h2>Golden Boot</h2></div><Trophy size={18} className="panel-icon" /></div><div className="scorer-list">{scorers.slice(0, 6).map((player, index) => <div className="scorer-row" key={`${player.teamId}-${player.name}`}><span className="scorer-rank">{String(index + 1).padStart(2, "0")}</span><div className="scorer-avatar">{initials(player.name)}</div><div><strong>{player.name}</strong><small>{player.teamName}</small></div><b>{player.goals}</b></div>)}{!scorers.length && <p className="muted-copy">Goal scorer data will appear after the first confirmed result.</p>}</div></aside></div><PlayerStatsPanel stats={playerStats} /></section>}

          {activeView === "database" && <DatabasePanel database={database} user={user} />}
          {activeView === "rules" && <RulesPanel rules={database.tiebreakers} isAdmin={isAdmin} onReset={resetRules} />}
        </main>
        <footer className="league-footer"><span><Database size={14} /> Source of truth: confirmed matches</span><span>eLeague Manager · {database.league.season}</span>{isAdmin ? <button onClick={resetDatabase}>Reset demo data</button> : <span>Player view · protected</span>}</footer>
      </div>
      {resultMatchId && <ResultDrawer database={database} matchId={resultMatchId} playerStats={playerStats} onClose={() => setResultMatchId(null)} onSave={saveResult} />}
    </div>
  );
}
