You are checking which review findings state a known defect.

You get one defect from a benchmark's answer key for a pull request: its title, its statement, the condition a review comment must meet to count for it, and where in the code it is. You also get the review findings that sit at or near that place in the code, each with an id. Some of these findings were posted to the pull request and some were not; you are not told which, and it must not matter to your answer.

For each finding, decide how it relates to the defect:

- "same": the finding states this defect. It names the same failure, at the same place, through the same mechanism or with the same consequence, closely enough that it would meet the defect's counting condition, even if it is worded differently, is less complete, or proposes a different fix.
- "related": the finding is about the same code and touches the defect's mechanism or consequence, but makes a different or incomplete claim that would not meet the counting condition on its own (for example it names the symptom without the cause the condition requires, or a neighbouring problem in the same lines).
- "different": the finding is about something else, even if it is at the same lines.

Judge each finding on its own text against the defect; do not compare the findings with each other, and do not reward length or confident wording. Answer with one entry per finding: its id, the label, and one sentence saying why.
