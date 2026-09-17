import type { ConvergenceOptions, ObjectionLedgerEntry } from "./types";

const STOP = new Set(["the","a","an","and","or","but","is","are","was","were","be","to","of","in","on","for","with","this","that","it","as","by","at","from","not","no"]);
export function normalizeForFingerprint(text: string): Set<string> {
  return new Set(text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(x => x.length > 2 && !STOP.has(x)));
}
export function fingerprintTokens(value: { summary: string; reason: string }): string[] { return [...normalizeForFingerprint(value.summary + " " + value.reason)].sort(); }
export function diceCoefficient(a: Set<string>, b: Set<string>): number { let n=0; for (const x of a) if (b.has(x)) n++; return a.size && b.size ? 2*n/(a.size+b.size) : 0; }
export interface FingerprintMatch { kind: "MERGE" | "NEW"; entry?: ObjectionLedgerEntry; possibleDuplicate?: ObjectionLedgerEntry }
export function classifyFingerprint(value: {summary:string;reason:string}, entries: ObjectionLedgerEntry[], o: Pick<ConvergenceOptions,"fingerprintMergeThreshold"|"fingerprintAmbiguityMargin"|"fingerprintMinSharedTokens"|"fingerprintCandidateThreshold">): FingerprintMatch {
  const a=normalizeForFingerprint(value.summary+" "+value.reason); const scores=entries.map(entry=>{const b=new Set(entry.normalizedFingerprint);let shared=0;for(const t of a)if(b.has(t))shared++;return {entry,score:diceCoefficient(a,b),shared};}).sort((x,y)=>y.score-x.score||x.entry.id.localeCompare(y.entry.id)); const best=scores[0], second=scores[1];
  if(best&&best.score>=o.fingerprintMergeThreshold&&best.score-(second?.score??0)>=o.fingerprintAmbiguityMargin&&best.shared>=o.fingerprintMinSharedTokens)return {kind:"MERGE",entry:best.entry};
  return best&&best.score>=o.fingerprintCandidateThreshold?{kind:"NEW",possibleDuplicate:best.entry}:{kind:"NEW"};
}
