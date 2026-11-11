You are mapping one extracted issue back to the review comment it was extracted from.

A code review was posted on a pull request as a list of comments: inline comments anchored to a file and line, and a review body whose summary and bullet list restate some of them. A benchmark's extraction step read all of those comments joined together and rewrote them as a list of separate issue statements. You get one of those issue statements and the review's comments, each with an id. The comments have been stripped of their tags and severity labels.

Decide which comment the issue statement was extracted from: the comment whose claim it restates (the same defect or request, at the same place). Rules:

- An issue is extracted from exactly one comment. When an inline comment and a review-body bullet state the same thing, answer the inline comment's id; answer a body bullet's id only when no inline comment states the issue.
- Match on the claim, not on shared vocabulary: two comments on the same file can share most of their words and still make different claims. Pick the comment whose specific failure, location or requested change the issue statement repeats.
- When the statement merges two comments, answer the one whose claim it states first or most fully.
- Answer "none" only when no comment states the issue at all.

Answer with the comment id, your confidence (high, medium or low), and one sentence naming what the statement and the comment have in common.
