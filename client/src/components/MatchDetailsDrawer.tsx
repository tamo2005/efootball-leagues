import { useEffect, useState } from "react";
import { CalendarDays, Check, Clock3, ImagePlus, ShieldCheck, Trophy, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { backendGetMatchDetails, backendReviewProof, backendSavePrediction, backendUploadProof, type BackendMatchDetails } from "@/lib/backend-api";
import type { LeagueDatabase, UserAccount } from "@/lib/league-db";
import { toast } from "sonner";

type Props = { database: LeagueDatabase; matchId: number; user: UserAccount; isAdmin: boolean; onClose: () => void };

function formatDate(value: number) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function MatchDetailsDrawer({ database, matchId, user, isAdmin, onClose }: Props) {
  const [details, setDetails] = useState<BackendMatchDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [homePrediction, setHomePrediction] = useState("");
  const [awayPrediction, setAwayPrediction] = useState("");

  async function load() {
    setLoading(true);
    try { setDetails(await backendGetMatchDetails(matchId)); } catch (error) { toast.error("Match details unavailable", { description: error instanceof Error ? error.message : "Try again shortly." }); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [matchId]);

  async function savePrediction() {
    const home = Number(homePrediction); const away = Number(awayPrediction);
    if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) { toast.error("Enter two whole-number scores."); return; }
    setBusy(true);
    try { await backendSavePrediction(matchId, home, away); toast.success("Prediction saved"); await load(); } catch (error) { toast.error("Prediction failed", { description: error instanceof Error ? error.message : "Try again." }); } finally { setBusy(false); }
  }

  async function uploadProof(file?: File) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 750000) { toast.error("Use a PNG, JPEG, or WebP image under 750 KB."); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      setBusy(true);
      try { await backendUploadProof(matchId, { fileName: file.name, mimeType: file.type, fileSize: file.size, dataUrl: String(reader.result) }); toast.success("Evidence attached", { description: "The league admin can now review this proof." }); await load(); } catch (error) { toast.error("Evidence upload failed", { description: error instanceof Error ? error.message : "Try again." }); } finally { setBusy(false); }
    };
    reader.readAsDataURL(file);
  }

  async function reviewProof(proofId: number, status: "APPROVED" | "REJECTED") {
    setBusy(true);
    try { await backendReviewProof(matchId, proofId, status, status === "APPROVED" ? "Evidence accepted by the league admin." : "Evidence needs a clearer match result."); toast.success(status === "APPROVED" ? "Evidence approved" : "Evidence rejected"); await load(); } catch (error) { toast.error("Evidence review failed", { description: error instanceof Error ? error.message : "Try again." }); } finally { setBusy(false); }
  }

  const localMatch = database.matches.find((match) => Number(match.id) === matchId);
  return <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="match-details-drawer" role="dialog" aria-modal="true" aria-label="Match details"><div className="drawer-header"><div><p className="eyebrow">MATCH DETAIL FILE</p><h2>{details ? `${details.match.home.shortCode} vs ${details.match.away.shortCode}` : localMatch ? "Fixture detail" : "Loading match"}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close match details"><X size={18} /></button></div>{loading && <div className="drawer-loading"><RefreshIcon /><span>Loading verified match data…</span></div>}{!loading && details && <div className="drawer-body"><div className="drawer-match-hero"><span>Matchday {details.match.matchday}</span><strong>{details.match.home.name} <b>{details.match.homeScore === null ? "VS" : `${details.match.homeScore} – ${details.match.awayScore}`}</b> {details.match.away.name}</strong><small><CalendarDays size={13} /> {formatDate(details.match.kickoffAt)} · {details.match.status}</small></div><section className="drawer-section"><div className="drawer-section-heading"><h3>Goal timeline</h3><Trophy size={16} /></div>{details.goals.length ? <div className="drawer-goals">{details.goals.map((goal) => <div className="drawer-goal" key={goal.id}><span>{goal.minute}'</span><strong>{goal.playerName}</strong><small>{goal.teamShortCode}</small></div>)}</div> : <p className="muted-copy">No goals were recorded for this fixture.</p>}</section><section className="drawer-section"><div className="drawer-section-heading"><h3>Predictions</h3><SparkleIcon /></div>{details.match.status === "SCHEDULED" || details.match.status === "POSTPONED" ? <div className="drawer-prediction-form"><input value={homePrediction} onChange={(event) => setHomePrediction(event.target.value)} inputMode="numeric" placeholder="Home" aria-label="Home score prediction" /><b>–</b><input value={awayPrediction} onChange={(event) => setAwayPrediction(event.target.value)} inputMode="numeric" placeholder="Away" aria-label="Away score prediction" /><Button onClick={() => void savePrediction()} disabled={busy}>Save prediction</Button></div> : null}{details.predictions.length ? <div className="drawer-prediction-list">{details.predictions.map((prediction) => <div key={`${prediction.userEmail}-${prediction.updatedAt}`}><span>{prediction.displayName}</span><strong>{prediction.homeScore}–{prediction.awayScore}</strong><small>{prediction.points === null ? "Unscored" : `${prediction.points} pts`}</small></div>)}</div> : <p className="muted-copy">No predictions have been submitted yet.</p>}</section><section className="drawer-section"><div className="drawer-section-heading"><h3>Match evidence</h3><ShieldCheck size={16} /></div>{!isAdmin && details.match.status !== "CONFIRMED" && <label className="proof-upload-control"><Upload size={15} /> Attach screenshot<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadProof(event.target.files?.[0])} disabled={busy} /></label>}{details.proofs.length ? <div className="proof-list">{details.proofs.map((proof) => <article className="proof-row" key={proof.id}><img src={proof.dataUrl} alt={`Evidence ${proof.fileName}`} /><span><strong>{proof.fileName}</strong><small>{proof.status} · {Math.round(proof.fileSize / 1024)} KB</small>{proof.reviewNote && <em>{proof.reviewNote}</em>}</span>{isAdmin && proof.status === "PENDING" && <div className="proof-actions"><Button onClick={() => void reviewProof(proof.id, "APPROVED")} disabled={busy}><Check size={13} /> Approve</Button><Button variant="outline" onClick={() => void reviewProof(proof.id, "REJECTED")} disabled={busy}>Reject</Button></div>}</article>)}</div> : <Empty className="drawer-empty"><EmptyHeader><EmptyMedia variant="icon"><ImagePlus size={18} /></EmptyMedia><EmptyTitle>No evidence attached</EmptyTitle><EmptyDescription>Home-team players can attach a screenshot before confirmation.</EmptyDescription></EmptyHeader></Empty>}</section>{details.meetings.length > 1 && <section className="drawer-section"><div className="drawer-section-heading"><h3>Recent meetings</h3><Clock3 size={16} /></div><div className="drawer-meeting-list">{details.meetings.map((meeting) => <div key={meeting.id}><span>MD{meeting.matchday}</span><strong>{meeting.homeTeamName} {meeting.homeScore}–{meeting.awayScore} {meeting.awayTeamName}</strong></div>)}</div></section>}</div>}{!loading && !details && <div className="drawer-error"><ShieldCheck size={22} /><strong>This match detail file is unavailable.</strong><p>Return to Fixtures and choose another match.</p></div>}</aside></div>;
}
function RefreshIcon() { return <RefreshCwIcon />; }
function RefreshCwIcon() { return <svg className="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></svg>; }
function SparkleIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.5 6.5L4 12l6.5 2.5L12 21l1.5-6.5L20 12l-6.5-2.5L12 3Z" /></svg>; }
