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
  calculateStandings,
  countConfirmed,
  countPending,
  formatMatchDate,
  getDatabase,
  leaderboard,
  makeId,
  matchLabel,
  saveDatabase,
  teamById,
  type Activity as LeagueActivity,
  type Goal,
  type LeagueDatabase,
  type Match,
  type Standing,
  type Team,
} from "@/lib/league-db";

type View = "overview" | "fixtures" | "teams" | "table";
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

function MatchRow({ database, match, onResult, onConfirm }: { database: LeagueDatabase; match: Match; onResult: (id: string) => void; onConfirm: (id: string) => void }) {
  const home = teamById(database.teams, match.homeTeamId);
  const away = teamById(database.teams, match.awayTeamId);
  const canConfirm = match.status === "PENDING";
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

function ResultDrawer({ database, matchId, onClose, onSave }: { database: LeagueDatabase; matchId: string; onClose: () => void; onSave: (matchId: string, homeScore: number, awayScore: number, goals: Goal[]) => void }) {
  const match = database.matches.find((item) => item.id === matchId);
  const home = match ? teamById(database.teams, match.homeTeamId) : undefined;
  const away = match ? teamById(database.teams, match.awayTeamId) : undefined;
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
  const [activeView, setActiveView] = useState<View>("overview");
  const [resultMatchId, setResultMatchId] = useState<string | null>(null);
  const [showTeamForm, setShowTeamForm] = useState(false);
  const [fixtureFilter, setFixtureFilter] = useState<"all" | "upcoming" | "pending" | "completed">("all");
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => saveDatabase(database), [database]);

  const standings = useMemo(() => calculateStandings(database), [database]);
  const scorers = useMemo(() => leaderboard(database), [database]);
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

  function openResult(matchId?: string) {
    const id = matchId ?? pendingMatch?.id ?? nextMatch?.id;
    if (!id) {
      toast("Every fixture already has a result.", { description: "The league is ready for the next season." });
      return;
    }
    setResultMatchId(id);
  }

  function saveResult(matchId: string, homeScore: number, awayScore: number, goals: Goal[]) {
    setDatabase((current) => ({
      ...current,
      matches: current.matches.map((match) => match.id === matchId ? { ...match, homeScore, awayScore, goals, status: "PENDING", submittedBy: "Alex Morgan", submittedAt: new Date().toISOString() } : match),
      activities: [{ id: makeId("activity"), kind: "result" as const, title: "Alex submitted a result", detail: `${matchLabel({ ...current, matches: current.matches }, { ...current.matches.find((match) => match.id === matchId)!, homeScore, awayScore })} · awaiting confirmation`, time: "Just now" }, ...current.activities].slice(0, 5),
    }));
    setResultMatchId(null);
    toast.success("Result saved", { description: "The away team has been notified for confirmation." });
  }

  function confirmMatch(matchId: string) {
    setDatabase((current) => {
      const match = current.matches.find((item) => item.id === matchId);
      if (!match) return current;
      return {
        ...current,
        matches: current.matches.map((item) => item.id === matchId ? { ...item, status: "CONFIRMED" } : item),
        activities: [{ id: makeId("activity"), kind: "update" as const, title: "Result confirmed", detail: `${matchLabel(current, match)} · table updated live`, time: "Just now" }, ...current.activities].slice(0, 5),
      };
    });
    toast.success("Result confirmed", { description: "Standings and player stats are now official." });
  }

  function addTeam(name: string, shortName: string, manager: string) {
    const team: Team = { id: makeId("team"), name, shortName, manager, accent: ["#9dd36a", "#79b9f2", "#bf9cf3", "#f1b664", "#f28d9d"][database.teams.length % 5] };
    setDatabase((current) => ({ ...current, teams: [...current.teams, team], league: { ...current.league, teamsCount: current.teams.length + 1 }, activities: [{ id: makeId("activity"), kind: "update" as const, title: `${name} joined the league`, detail: `${manager} · ${shortName}`, time: "Just now" }, ...current.activities].slice(0, 5) }));
    setShowTeamForm(false);
    toast.success(`${name} added`, { description: "The team record is saved. Generate fixtures when ready." });
  }

  function resetDatabase() {
    setDatabase(getDatabase().league.id ? getDatabase() : database);
    toast("Demo database restored", { description: "Seed fixtures and results are back in place." });
  }

  const currentTitle = activeView === "overview" ? "Good afternoon, Alex" : activeView === "fixtures" ? "Fixtures & results" : activeView === "teams" ? "Teams & managers" : "Live league table";
  const currentDescription = activeView === "overview" ? "Keep the league moving with one clear place for every result, roster, and ranking." : activeView === "fixtures" ? "Every scheduled match, submission, and confirmation in one calm workflow." : activeView === "teams" ? "Manage the clubs and eFootball accounts that power this season." : "Official standings calculated from confirmed match results.";

  return (
    <div className="league-app">
      <aside className="league-sidebar">
        <div className="league-brand"><span className="brand-ball"><span /></span><div><strong>eLeague<span>.</span></strong><small>matchday manager</small></div></div>
        <div className="league-selector"><span className="selector-mark">RC</span><div><small>ACTIVE LEAGUE</small><strong>{database.league.name}</strong></div><ChevronDown size={15} /></div>
        <nav className="league-nav" aria-label="League navigation">
          <p className="nav-label">Workspace</p>
          <button className={activeView === "overview" ? "active" : ""} onClick={() => setActiveView("overview")}><LayoutDashboard size={17} />Overview<span className="nav-shortcut">01</span></button>
          <button className={activeView === "fixtures" ? "active" : ""} onClick={() => setActiveView("fixtures")}><CalendarDays size={17} />Fixtures<span className="nav-count">{pendingCount}</span></button>
          <button className={activeView === "table" ? "active" : ""} onClick={() => setActiveView("table")}><Trophy size={17} />Standings</button>
          <button className={activeView === "teams" ? "active" : ""} onClick={() => setActiveView("teams")}><Users size={17} />Teams</button>
          <p className="nav-label nav-label-spaced">League tools</p>
          <button onClick={() => toast("Database is healthy", { description: `${database.matches.length} fixtures are stored locally and ready to sync.` })}><Database size={17} />Database<span className="nav-live">LIVE</span></button>
          <button onClick={() => toast("Rules are configured", { description: "Win 3 · Draw 1 · Loss 0 · GD is the first tiebreaker." })}><SlidersHorizontal size={17} />Rules</button>
        </nav>
        <div className="sidebar-footer"><div className="sync-status"><span className="sync-dot" /><div><strong>Saved locally</strong><small>Last sync · just now</small></div><RefreshCw size={14} /></div><button className="sidebar-user" onClick={() => toast("Admin account", { description: "You are managing River City eLeague." })}><span className="user-avatar">AM</span><span><strong>Alex Morgan</strong><small>League admin</small></span><MoreHorizontal size={16} /></button></div>
      </aside>

      <div className="league-main">
        <header className="league-topbar"><button className="mobile-menu" aria-label="Open menu"><Menu size={20} /></button><div className="breadcrumbs"><span>River City eLeague</span><ChevronRight size={14} /><strong>{activeView === "overview" ? "Overview" : currentTitle}</strong></div><div className="topbar-right"><span className="live-indicator"><span />Live updates</span><button className="topbar-icon" aria-label="Search"><Search size={17} /></button><button className="topbar-icon" aria-label="Notifications" onClick={() => toast(pendingCount ? `${pendingCount} result needs attention` : "You are all caught up") }><Bell size={17} />{pendingCount > 0 && <span className="notification-dot" />}</button><div className="topbar-user"><span className="user-avatar">AM</span><ChevronDown size={14} /></div></div></header>
        <main className="league-content">
          <div className="page-intro"><div><p className="eyebrow">{database.league.season} <span className="intro-status"><span />{database.league.status}</span></p><h1>{currentTitle}</h1><p>{currentDescription}</p></div><div className="intro-actions"><Button variant="outline" onClick={() => setActiveView("fixtures")}><CalendarDays size={16} /> View fixtures</Button><Button onClick={() => openResult()}><Plus size={16} /> Submit result</Button></div></div>

          {activeView === "overview" && <>
            <div className="hero-grid"><section className="hero-card"><div className="hero-copy"><span className="hero-kicker"><span className="hero-live-dot" /> Matchday {database.matches[0]?.matchday ?? 1} in progress</span><h2>Keep the league<br /><em>moving forward.</em></h2><p>{pendingCount ? `${pendingCount} result is waiting for confirmation. Keep the official table clean with one quick review.` : "All results are up to date. The next fixture is ready when your players are."}</p><div className="hero-actions"><Button onClick={() => openResult()}>{pendingCount ? "Review pending result" : "Enter next result"} <ArrowRight size={15} /></Button><button className="hero-text-action" onClick={() => setActiveView("fixtures")}>Open match centre <ArrowRight size={14} /></button></div></div><div className="pitch-art" aria-hidden="true"><div className="pitch-line pitch-midline" /><div className="pitch-circle" /><div className="pitch-box pitch-box-top" /><div className="pitch-box pitch-box-bottom" /><span className="pitch-player player-one" /><span className="pitch-player player-two" /><span className="pitch-player player-three" /><span className="pitch-player player-four" /></div></section><aside className="attention-card"><div className="attention-top"><span className="eyebrow">NEEDS YOUR ATTENTION</span><span className="attention-icon"><Bell size={16} /></span></div><strong>{pendingCount ? "One result is waiting" : "No reviews waiting"}</strong><p>{pendingMatch ? `${teamById(database.teams, pendingMatch.homeTeamId)?.name} submitted a ${pendingMatch.homeScore}–${pendingMatch.awayScore} result against ${teamById(database.teams, pendingMatch.awayTeamId)?.name}.` : "Your league is clear. New submissions will appear here."}</p>{pendingMatch ? <button onClick={() => confirmMatch(pendingMatch.id)}>Confirm result <Check size={15} /></button> : <span className="attention-clear"><ShieldCheck size={15} />Everything is up to date</span>}</aside></div>
            <div className="metric-grid"><MetricCard label="Confirmed matches" value={`${confirmedCount} / ${database.matches.length}`} note={`${Math.round((confirmedCount / database.matches.length) * 100)}% of the season complete`} accent="#9dd36a" icon={Check} /><MetricCard label="Pending confirmation" value={String(pendingCount).padStart(2, "0")} note="Review before the table updates" accent="#f0b35b" icon={Clock3} /><MetricCard label="Teams competing" value={String(database.teams.length).padStart(2, "0")} note="All manager records are assigned" accent="#79b9f2" icon={Users} /><MetricCard label="Database health" value="100%" note="No duplicate or missing records" accent="#bf9cf3" icon={Database} /></div>
            <div className="dashboard-grid"><section className="panel standings-panel"><div className="panel-header"><div><p className="eyebrow">01 / OFFICIAL TABLE</p><h2>Standings</h2></div><button className="panel-link" onClick={() => setActiveView("table")}>Full table <ArrowRight size={14} /></button></div><StandingTable standings={standings} compact /></section><section className="panel activity-panel"><div className="panel-header"><div><p className="eyebrow">02 / LIVE FEED</p><h2>Recent activity</h2></div><Activity size={18} className="panel-icon" /></div><ActivityFeed activities={database.activities} /></section></div>
            <section className="panel next-fixtures-panel"><div className="panel-header"><div><p className="eyebrow">03 / NEXT UP</p><h2>Fixture desk</h2></div><button className="panel-link" onClick={() => setActiveView("fixtures")}>See all {database.matches.length} fixtures <ArrowRight size={14} /></button></div><div className="next-fixtures-list">{database.matches.filter((match) => match.status !== "CONFIRMED").slice(0, 3).map((match) => <MatchRow key={match.id} database={database} match={match} onResult={openResult} onConfirm={confirmMatch} />)}</div></section>
          </>}

          {activeView === "fixtures" && <section className="view-panel"><div className="fixture-toolbar"><div className="filter-tabs">{(["all", "upcoming", "pending", "completed"] as const).map((filter) => <button className={fixtureFilter === filter ? "selected" : ""} key={filter} onClick={() => setFixtureFilter(filter)}>{filter === "all" ? "All fixtures" : filter === "upcoming" ? "Upcoming" : filter === "pending" ? `Needs review ${pendingCount ? `· ${pendingCount}` : ""}` : "Completed"}</button>)}</div><label className="search-field"><Search size={15} /><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search teams" /></label></div><div className="fixture-groups">{groupedFixtures.length ? groupedFixtures.map((group) => <section className="fixture-group" key={group.matchday}><div className="fixture-group-heading"><span className="matchday-number">{String(group.matchday).padStart(2, "0")}</span><div><p className="eyebrow">MATCHDAY {group.matchday}</p><h2>{formatMatchDate(group.matches[0].date)}</h2></div><span className="fixture-group-count">{group.matches.length} matches</span></div>{group.matches.map((match) => <MatchRow key={match.id} database={database} match={match} onResult={openResult} onConfirm={confirmMatch} />)}</section>) : <div className="empty-panel"><CalendarDays size={24} /><h3>No fixtures match this view.</h3><p>Try a different status or clear the team search.</p></div>}</div></section>}

          {activeView === "teams" && <section className="view-panel"><div className="view-toolbar"><div><p className="eyebrow">ROSTER DIRECTORY</p><h2>{database.teams.length} teams in this season</h2></div><Button onClick={() => setShowTeamForm((current) => !current)}>{showTeamForm ? <X size={16} /> : <Plus size={16} />} {showTeamForm ? "Close form" : "Add team"}</Button></div>{showTeamForm && <AddTeamPanel onClose={() => setShowTeamForm(false)} onAdd={addTeam} />}<div className="team-grid">{database.teams.map((team, index) => { const row = standings.find((item) => item.id === team.id); return <article className="team-card" key={team.id}><div className="team-card-top"><TeamMark team={team} size="lg" /><span className="team-card-rank">#{index + 1}</span><button className="icon-button"><MoreHorizontal size={17} /></button></div><h3>{team.name}</h3><p><UserRound size={13} /> {team.manager}</p><div className="team-card-stats"><span><strong>{row?.played ?? 0}</strong><small>played</small></span><span><strong>{row?.points ?? 0}</strong><small>points</small></span><span><strong>{row?.goalDifference && row.goalDifference > 0 ? `+${row.goalDifference}` : row?.goalDifference ?? 0}</strong><small>goal diff</small></span></div><div className="team-card-footer"><span className="team-record"><span className="record-dot" />Database record active</span><ArrowRight size={15} /></div></article>; })}</div></section>}

          {activeView === "table" && <section className="view-panel"><div className="table-view-grid"><section className="panel full-table-panel"><div className="panel-header"><div><p className="eyebrow">OFFICIAL STANDINGS</p><h2>River City eLeague table</h2></div><span className="table-updated"><span />Updated live</span></div><StandingTable standings={standings} /></section><aside className="panel golden-boot-panel"><div className="panel-header"><div><p className="eyebrow">PLAYER STATS</p><h2>Golden Boot</h2></div><Trophy size={18} className="panel-icon" /></div><div className="scorer-list">{scorers.slice(0, 6).map((player, index) => <div className="scorer-row" key={`${player.teamId}-${player.name}`}><span className="scorer-rank">{String(index + 1).padStart(2, "0")}</span><div className="scorer-avatar">{initials(player.name)}</div><div><strong>{player.name}</strong><small>{player.teamName}</small></div><b>{player.goals}</b></div>)}{!scorers.length && <p className="muted-copy">Goal scorer data will appear after the first confirmed result.</p>}</div></aside></div></section>}
        </main>
        <footer className="league-footer"><span><Database size={14} /> Source of truth: confirmed matches</span><span>eLeague Manager · {database.league.season}</span><button onClick={resetDatabase}>Reset demo data</button></footer>
      </div>
      {resultMatchId && <ResultDrawer database={database} matchId={resultMatchId} onClose={() => setResultMatchId(null)} onSave={saveResult} />}
    </div>
  );
}
