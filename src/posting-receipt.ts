import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerdictFile } from "./types.js";

export type PostingReceiptStatus = "prepared" | "confirmed" | "dryrun";

export interface PostingReceipt {
  version: 1;
  posting_key: string;
  marker: string;
  pr: number;
  round_no: number;
  head_sha: string;
  intended_event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  actual_event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  status: PostingReceiptStatus;
  payload_sha256: string;
  prepared_at: string;
  confirmed_at?: string;
  gh_review_id?: number;
  gh_commit_id?: string;
  gh_state?: string;
}

export function roundPostingKey(pr: number, roundNo: number, headSha: string): string {
  return `v1:${pr}:${roundNo}:${headSha.toLowerCase()}`;
}

export function postingMarker(key: string): string {
  return `<!-- qcr-post:${key} -->`;
}

export function postingReceiptPath(dir: string, pr: number, roundNo: number): string {
  return join(dir, `pr-${pr}-round-${roundNo}.json`);
}

function event(value: unknown): PostingReceipt["actual_event"] | undefined {
  return value === "APPROVE" || value === "REQUEST_CHANGES" || value === "COMMENT" ? value : undefined;
}

export function parsePostingReceipt(raw: string): PostingReceipt | undefined {
  try {
    const value = JSON.parse(raw) as Partial<PostingReceipt>;
    if (
      value.version !== 1 || typeof value.posting_key !== "string" ||
      value.marker !== postingMarker(value.posting_key) ||
      typeof value.pr !== "number" || !Number.isInteger(value.pr) ||
      typeof value.round_no !== "number" || !Number.isInteger(value.round_no) ||
      typeof value.head_sha !== "string" || value.head_sha.length === 0 ||
      !event(value.intended_event) || !event(value.actual_event) ||
      (value.status !== "prepared" && value.status !== "confirmed" && value.status !== "dryrun") ||
      typeof value.payload_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.payload_sha256) ||
      typeof value.prepared_at !== "string" || !Number.isFinite(Date.parse(value.prepared_at))
    ) return undefined;
    if (value.status === "confirmed") {
      const expectedState = value.actual_event === "APPROVE"
        ? "APPROVED"
        : value.actual_event === "REQUEST_CHANGES"
          ? "CHANGES_REQUESTED"
          : "COMMENTED";
      if (
        typeof value.gh_review_id !== "number" || !Number.isInteger(value.gh_review_id) ||
        typeof value.gh_commit_id !== "string" || value.gh_commit_id.toLowerCase() !== value.head_sha.toLowerCase() ||
        value.gh_state !== expectedState ||
        typeof value.confirmed_at !== "string" || !Number.isFinite(Date.parse(value.confirmed_at))
      ) return undefined;
    }
    return value as PostingReceipt;
  } catch {
    return undefined;
  }
}

export function receiptMatchesVerdict(receipt: PostingReceipt, verdict: VerdictFile): boolean {
  if (receipt.pr !== verdict.pr || receipt.round_no !== verdict.round_no || receipt.head_sha.toLowerCase() !== verdict.head_sha.toLowerCase()) return false;
  if (verdict.verdict === "REQUEST_CHANGES") return receipt.actual_event === "REQUEST_CHANGES" || receipt.actual_event === "COMMENT";
  if (verdict.verdict === "APPROVE") return verdict.approval_withheld === true ? receipt.actual_event === "COMMENT" : receipt.actual_event === "APPROVE";
  return receipt.actual_event === "COMMENT";
}

export function readPostingReceipt(dir: string, pr: number, roundNo: number): PostingReceipt | undefined {
  try {
    return parsePostingReceipt(readFileSync(postingReceiptPath(dir, pr, roundNo), "utf8"));
  } catch {
    return undefined;
  }
}
