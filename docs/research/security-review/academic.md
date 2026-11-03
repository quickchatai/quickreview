# Security lenses for an LLM code reviewer: taxonomies, evidence, failure modes, benchmarks

Research date: 2026-11-02. Primary sources are preferred (arXiv, ACL, USENIX, ICSE, OWASP, MITRE).
Each claim is followed by its source URL. Items I could only confirm from secondary sources, or that
contain internal inconsistencies, are marked **[UNVERIFIED]** or **[CAVEAT]**. Section 6 collects them.

Context: the reviewer runs read-only agents (grep/read, no execution) as single-concern "lenses" over PR
diffs and a whole-repo scan mode, followed by an adversarial validator.

---

## 1. Taxonomies

### 1.1 OWASP Top 10:2025 (web application risks)

The list as published by the OWASP project (https://top10.owasp.org/2025):

| ID | Name |
|---|---|
| A01:2025 | Broken Access Control |
| A02:2025 | Security Misconfiguration |
| A03:2025 | Software Supply Chain Failures |
| A04:2025 | Cryptographic Failures |
| A05:2025 | Injection |
| A06:2025 | Insecure Design |
| A07:2025 | Authentication Failures |
| A08:2025 | Software or Data Integrity Failures |
| A09:2025 | Security Logging and Alerting Failures |
| A10:2025 | Mishandling of Exceptional Conditions |

Source: https://top10.owasp.org/2025 (owasp.org/Top10/2025/ now redirects there).
Category pages follow the pattern `https://top10.owasp.org/2025/A01_2025-Broken_Access_Control/`
(relative links as shown on the index page, https://top10.owasp.org/2025).

Release timeline: announced as a release candidate at OWASP Global AppSec in Washington DC in November 2025
(https://www.pentasecurity.com/?p=32222, https://parasoft.com/blog/owasp-top-10/). Secondary sources say it was
finalized in January 2026 (https://parasoft.com/blog/owasp-top-10/). **[UNVERIFIED: exact finalization date.
The official index page carries no date (https://top10.owasp.org/2025).]**

Two entries are new and matter for a reviewer: A03 Software Supply Chain Failures and A10 Mishandling of Exceptional
Conditions (fail-open error handling) (https://top10.owasp.org/2025).

### 1.2 CWE Top 25 Most Dangerous Software Weaknesses, 2025 (MITRE)

The list is built from 39,080 CVE records published between June 1, 2024 and June 1, 2025
(https://cwe.mitre.org/top25/archive/2025/2025_methodology.html). For the first time, MITRE used the CWE mappings as
provided instead of normalizing them to View-1003 (https://cwe.mitre.org/top25/archive/2025/2025_methodology.html).
It was published in December 2025 (https://securityweek.com/mitre-releases-2025-list-of-top-25-most-dangerous-software-vulnerabilities/).

Full table from https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html:

| Rank | CWE | Name | Score | Δ vs 2024 |
|---|---|---|---|---|
| 1 | CWE-79 | Cross-site Scripting | 60.38 | 0 |
| 2 | CWE-89 | SQL Injection | 28.72 | +1 |
| 3 | CWE-352 | Cross-Site Request Forgery | 13.64 | +1 |
| 4 | CWE-862 | Missing Authorization | 13.28 | +5 |
| 5 | CWE-787 | Out-of-bounds Write | 12.68 | −3 |
| 6 | CWE-22 | Path Traversal | 8.99 | −1 |
| 7 | CWE-416 | Use After Free | 8.47 | +1 |
| 8 | CWE-125 | Out-of-bounds Read | 7.88 | −2 |
| 9 | CWE-78 | OS Command Injection | 7.85 | −2 |
| 10 | CWE-94 | Code Injection | 7.57 | +1 |
| 11 | CWE-120 | Classic Buffer Overflow | 6.96 | new |
| 12 | CWE-434 | Unrestricted Upload of Dangerous File Type | 6.87 | −2 |
| 13 | CWE-476 | NULL Pointer Dereference | 6.41 | +8 |
| 14 | CWE-121 | Stack-based Buffer Overflow | 5.75 | new |
| 15 | CWE-502 | Deserialization of Untrusted Data | 5.23 | +1 |
| 16 | CWE-122 | Heap-based Buffer Overflow | 5.21 | new |
| 17 | CWE-863 | Incorrect Authorization | 4.14 | +1 |
| 18 | CWE-20 | Improper Input Validation | 4.09 | −6 |
| 19 | CWE-284 | Improper Access Control | 4.07 | new |
| 20 | CWE-200 | Exposure of Sensitive Information | 4.01 | −3 |
| 21 | CWE-306 | Missing Authentication for Critical Function | 3.47 | +4 |
| 22 | CWE-918 | Server-Side Request Forgery | 3.36 | −3 |
| 23 | CWE-77 | Command Injection | 3.15 | −10 |
| 24 | CWE-639 | Authorization Bypass Through User-Controlled Key | 2.62 | +6 |
| 25 | CWE-770 | Allocation of Resources Without Limits or Throttling | 2.54 | +1 |

Five of the 25 are authorization or authentication weaknesses (CWE-862, 863, 284, 306, 639), and CWE-862 rose five
places (https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html). MITRE also publishes a 15-entry "on the cusp"
list (https://cwe.mitre.org/top25/archive/2025/2025_onthecusp_insights.html).

### 1.3 OWASP API Security Top 10 – 2023

From https://api-security.owasp.org/editions/2023/en/0x11-t10 (redirected from owasp.org/API-Security/…):

1. API1:2023 Broken Object Level Authorization
2. API2:2023 Broken Authentication
3. API3:2023 Broken Object Property Level Authorization
4. API4:2023 Unrestricted Resource Consumption
5. API5:2023 Broken Function Level Authorization
6. API6:2023 Unrestricted Access to Sensitive Business Flows
7. API7:2023 Server Side Request Forgery
8. API8:2023 Security Misconfiguration
9. API9:2023 Improper Inventory Management
10. API10:2023 Unsafe Consumption of APIs

### 1.4 OWASP Top 10 for LLM Applications 2025 (and the newer 2026 edition)

2025 edition, verbatim from https://genai.owasp.org/llm-top-10/:

1. LLM01:2025 Prompt Injection — https://genai.owasp.org/llmrisk/llm01-prompt-injection/
2. LLM02:2025 Sensitive Information Disclosure — https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/
3. LLM03:2025 Supply Chain — https://genai.owasp.org/llmrisk/llm032025-supply-chain/
4. LLM04:2025 Data and Model Poisoning — https://genai.owasp.org/llmrisk/llm042025-data-and-model-poisoning/
5. LLM05:2025 Improper Output Handling — https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/
6. LLM06:2025 Excessive Agency — https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
7. LLM07:2025 System Prompt Leakage — https://genai.owasp.org/llmrisk/llm072025-system-prompt-leakage/
8. LLM08:2025 Vector and Embedding Weaknesses — https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/
9. LLM09:2025 Misinformation — https://genai.owasp.org/llmrisk/llm092025-misinformation/
10. LLM10:2025 Unbounded Consumption — https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/

**A 2026 edition exists.** OWASP published "OWASP GenAI LLM Top 10 2026" dated August 3, 2026
(https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/). The resource page offers only a download, so I could not
read the list on an OWASP page. Two independent secondary sources agree on this order
(https://cloudsecurityalliance.org/articles/the-owasp-top-10-for-llm-applications-2026-what-changed-and-why-it-matters,
https://www.superblocks.com/blog/owasp-llm-top-10):
LLM01 Prompt Injection; LLM02 Sensitive Information Disclosure; LLM03 Excessive Agency (up from 6); LLM04 Supply Chain;
LLM05 Data and Model Poisoning; LLM06 Unbounded Consumption; LLM07 Misinformation; LLM08 Hidden Context Exposure (broadened
from System Prompt Leakage); LLM09 Vector and Embedding Weaknesses; LLM10 Improper Output Handling (down from 5).
**[UNVERIFIED against the OWASP PDF.]** The legacy owasp.org project page still names 2025 as the latest version
(https://owasp.org/www-project-top-10-for-large-language-model-applications/).

### 1.5 OWASP Top 10 for Agentic Applications (2026 edition, published 2025-12-09)

OWASP's GenAI Security Project published this list on December 9, 2025
(https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/). The landing page does not list the
entries. These names are consistent across several secondary sources
(https://docs.modulos.ai/frameworks/owasp-top-10-agentic/top-risks, https://www.giskard.ai/knowledge/owasp-top-10-for-agentic-application-2026,
https://www.speakeasy.com/blog/owasp-agentic-top-10-explained):

- ASI01 Agent Goal Hijack
- ASI02 Tool Misuse and Exploitation
- ASI03 Identity and Privilege Abuse
- ASI04 Agentic Supply Chain Vulnerabilities
- ASI05 Unexpected Code Execution
- ASI06 Memory and Context Poisoning
- ASI07 Insecure Inter-Agent Communication
- ASI08 Cascading Failures
- ASI09 Human-Agent Trust Exploitation
- ASI10 Rogue Agents

**[UNVERIFIED against the OWASP PDF. Some sources shorten the names slightly, for example "Code Execution" or
"Inter-Agent Comms".]**

The older OWASP Agentic Security Initiative document, "Agentic AI – Threats and Mitigations" (v1.0a, February 2025),
lists T1–T15. Secondary sources give: T1 Memory Poisoning, T2 Tool Misuse, T3 Privilege Compromise, T4 Resource
Overload, T5 Cascading Hallucination, T6 Intent Breaking & Goal Manipulation, T7 Misaligned & Deceptive Behaviors,
T8 Repudiation & Untraceability, T9 Identity Spoofing, T10 Overwhelming Human-in-the-Loop, T11 Unexpected RCE and Code
Attacks, T12 Agent Communication Poisoning, T13 Rogue Agents, T14 Human Attacks on Multi-Agent Systems, T15 Human
Manipulation (https://techjacksolutions.com/?p=39015, https://alice.io/blog/owasp-agentic-ai-threats,
https://aws.amazon.com/cn/blogs/china/privacy-and-security-of-agent-applications). **[UNVERIFIED: the primary PDF was not read.]**

### 1.6 Recommendation: which taxonomy should organize the lenses

- **Use CWE IDs as the label space and the OWASP Top 10:2025 as the lens grouping.**
  - CWE is what the benchmarks label with. CASTLE, SecVulEval, PrimeVul, JitVul and VulnSage are all keyed by CWE
    (https://arxiv.org/abs/2503.09433, https://arxiv.org/html/2505.19828v1, https://arxiv.org/html/2403.18624v2, https://arxiv.org/html/2503.03586, https://arxiv.org/pdf/2503.17885).
  - The CWE-specific rubric results (§2.3) need per-CWE knowledge.
  - OWASP categories are coarse enough to be single-concern lenses.
- **Add API Top 10 checks to the access-control lens.** API1, API3 and API5 (object, property and function-level
  authorization) are the code-review-visible form of CWE-862/863/639
  (https://api-security.owasp.org/editions/2023/en/0x11-t10, https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html).
- **Add one LLM/agent lens** that draws on LLM01/LLM05/LLM06 (2025) or LLM03 (2026) and ASI01–ASI05. Those entries are
  the ones visible in application source: untrusted content reaching a prompt, model output reaching a sink, and tool
  authority (https://genai.owasp.org/llm-top-10/, https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/).

---

## 2. What the literature says works

### 2.1 Baseline reality: generic "is this vulnerable?" prompting does not work

- **Ullah et al., "LLMs Cannot Reliably Identify and Reason about Security Vulnerabilities (Yet?)", IEEE S&P 2024.**
  - Scope: 228 scenarios, 8 LLMs, 8 CWEs (https://arxiv.org/abs/2312.12575).
  - Answers were non-deterministic, and the reasoning was often wrong or unfaithful to the answer (https://arxiv.org/abs/2312.12575).
  - Renaming functions or variables, or adding library functions, flipped answers in 26% (PaLM2) and 17% (GPT-4) of cases (https://arxiv.org/abs/2312.12575).
  - Few-shot prompting beat zero-shot (p = 0.003), and role prompts were only slightly better than task prompts (p = 0.1) (https://arxiv.org/html/2312.12575v3).
  - On 30 real-world CVE scenarios, models often flagged the patched code as still vulnerable (https://arxiv.org/html/2312.12575v3).
- **PrimeVul, Ding et al., ICSE 2025.** This is the paper titled "Vulnerability Detection with Code Language Models: How
  Far Are We?", so it and PrimeVul are one source.
  - A 7B model scored 68.26% F1 on BigVul but 3.09% F1 on PrimeVul (https://arxiv.org/abs/2403.18624).
  - On paired vulnerable/fixed functions, GPT-4 with chain-of-thought got both right in only 12.94% of pairs (P-C).
    Random guessing gets 22.70%. GPT-4 two-shot marked both versions vulnerable in 71.63% of pairs (https://arxiv.org/html/2403.18624v2).
- **Steenhoek et al., "To Err is Machine".**
  - 14 LLMs on SVEN reached 50–55% balanced accuracy at best, with a best of 54.5% (https://arxiv.org/html/2403.17218v2).
  - Misunderstood bounds/NULL checks caused 50% (80/159) of localization errors (https://arxiv.org/html/2403.17218v2).
  - Model size did not correlate with performance (R² = 0.02, p = 0.72) (https://arxiv.org/html/2403.17218v2).
- **Risse & Böhme, USENIX Security 2024.** ML vulnerability detectors reached up to 70% accuracy but could not tell
  vulnerable functions from their patched versions, and they overfit to unrelated features (https://arxiv.org/abs/2306.17193).

**Lesson:** function-level binary classification is the wrong frame, and models are biased toward "vulnerable" on
patched code. Both points shape the validator design.

### 2.2 Static analysis plus LLM (neuro-symbolic): IRIS

IRIS (Li, Dutta, Naik) has the LLM infer taint source and sink specifications for CodeQL, then filter alerts with
contextual analysis (https://arxiv.org/html/2405.17238v3).

- **Specification inference.** CodeQL extracts candidate external and internal APIs. The LLM labels them in batches of
  30 (external) and 20 (internal). External APIs get 3–4 few-shot examples per CWE (https://arxiv.org/html/2405.17238v3).
- **Contextual filtering.** For each alert path, the prompt holds the CWE description and code snippets along the
  source→sink path, with ±5 lines around the source and sink. Paths are capped at 10 intermediate steps. The model
  explains before giving a verdict, and if it rejects the path it says whether the source or the sink is the false
  positive. That answer prunes sibling paths (https://arxiv.org/html/2405.17238v3).
- **Results on CWE-Bench-Java (120 vulnerabilities):**
  - CodeQL detected 27 (22.5%) with 90.03% average false discovery rate (FDR) and F1 0.076.
  - IRIS+GPT-4 detected 55 (45.83%) with 84.82% FDR and F1 0.177 (https://arxiv.org/html/2405.17238v3).
  - A manual check of 50 GPT-4 alarms suggests the real FDR is nearer 46% (https://arxiv.org/html/2405.17238v3).
- **Ablation.** Contextual filtering helped only strong models (GPT-4, GPT-3.5, Llama-3-70B). Smaller models got worse
  with it (https://arxiv.org/html/2405.17238v3).

**Take-away for us:**
- Ask for source/sink/sanitizer identification per CWE.
- Validate per path, and have the validator say which endpoint is wrong.
- Reserve the validator for a strong model.

### 2.3 CWE-specific prompting and data-flow chain-of-thought

- **Khare et al., "Understanding the Effectiveness of LLMs in Detecting Security Vulnerabilities".**
  - Scope: 16 LLMs, 5,000 samples. Step-by-step analysis improved F1 on real-world datasets by up to 0.18 on average (https://arxiv.org/abs/2311.16169).
  - GPT-4 on CVEFixes C/C++ (100-sample appendix):
    - CWE-specific prompt: P 0.54, R 0.58, F1 0.56.
    - CWE plus data-flow prompt (CWE-DF: name sources, sinks, sanitizers, then unsanitized flows): P 0.56, R 0.83, F1 0.67.
    - Generic CoT: F1 0.33.
    - Few-shot: F1 0.36 (https://arxiv.org/html/2311.16169v3).
  - The CWE-DF prompt identified sanitizers in 16/20 samples that the CWE-only prompt missed. It did so partly from
    textual cues, for example `csrftokenhandler()` (https://arxiv.org/html/2311.16169v3).
  - CodeQL still beat the LLMs on the synthetic sets, for example Juliet Java F1 0.94 vs best LLM 0.79 (https://arxiv.org/html/2311.16169v3).
- **ZeroFalse (SAST triage).** Each CodeQL alert is enriched with:
  - the annotated source→sink trace (each step marked as introduction, propagation or possible mitigation);
  - the enclosing methods;
  - a CWE-specific micro-rubric of 10–20 rules plus a checklist;
  - a strict JSON verdict with confidence (https://arxiv.org/html/2510.02534v1).

  Results, F1 baseline → optimized prompt:
  - gpt-5 on OpenVuln: 0.621 → 0.955.
  - gpt-oss-20b: 0.690 → 0.884 (OWASP Benchmark) and 0.523 → 0.904 (OpenVuln).
  - Gemini-2.5-pro fell to 0.372 on OpenVuln (https://arxiv.org/html/2510.02534v1).

  **[CAVEAT]** The rubric is not ablated separately from the trace. OpenVuln has only 58 alerts. The abstract's
  ">90% precision and recall" is not supported in every row of the body (https://arxiv.org/html/2510.02534v1).
- **Tencent industrial study (Du et al., 2026).** On 433 BkCheck alarms (C/C++ null-deref, divide-by-zero, out-of-bounds):
  - Few-shot and bug-type descriptions helped most among prompt-only methods.
  - Chain-of-thought was the weakest and sometimes underperformed the basic prompt (https://arxiv.org/html/2601.18844v1).

**Take-away:**
- Per-CWE rubrics plus explicit source/sink/sanitizer/flow enumeration is the prompting pattern with measured gains.
- Generic "think step by step" is unreliable. It helps sometimes (PrimeVul GPT-4, JitVul plain LLM) and hurts sometimes
  (Khare CVEFixes, Tencent) (https://arxiv.org/html/2403.18624v2, https://arxiv.org/html/2503.03586, https://arxiv.org/html/2311.16169v3, https://arxiv.org/html/2601.18844v1).

### 2.4 Knowledge retrieval (RAG)

- **Vul-RAG.** It retrieves vulnerability knowledge distilled from past CVE fixes, structured as functional semantics,
  vulnerability causes and fixing solutions. Code is flagged only if it shows the cause without the fix (https://arxiv.org/html/2406.11147v3).
  - On PairVul (586 Linux kernel pairs), pair accuracy rose from 0.06–0.14 (basic prompts) to 0.26–0.32. Code-level RAG
    (similar code snippets) gave only 0.05–0.11 (https://arxiv.org/html/2406.11147v3).
  - Main false-positive causes were mismatched fixing solutions (11) and irrelevant retrieval (10) (https://arxiv.org/html/2406.11147v3).
  - The generated knowledge raised human detection accuracy from 60% to 77% (https://arxiv.org/html/2406.11147v3).
- **LLM4Vuln.** Six models, 147 vulnerable and 147 non-vulnerable cases (https://arxiv.org/abs/2401.16185).
  - Knowledge augmentation had mixed effects. For Java and C/C++, true positives dropped in 89 of 96 knowledge
    combinations, and deep-reasoning models were often hurt by added knowledge (https://arxiv.org/html/2401.16185v4).
  - Context supplementation effects were "slight and inconsistent", and context "can also distract LLMs if not well-aligned" (https://arxiv.org/html/2401.16185v4).
  - CoT improved precision and reduced false positives for both model types (https://arxiv.org/html/2401.16185v4).
- **MultiVer.** In a Claude Opus 4.5 ensemble, disabling RAG raised recall (82.7% → 92.0%) but raised the FPR more
  (85.0% → 94.1%). RAG acted as a precision aid (https://arxiv.org/html/2602.17875v1).

**Take-away:**
- Retrieved knowledge helps when it is about mechanism and fix ("cause present and fix absent?").
- Similar-code retrieval does not help.
- Strong reasoning models gain little or lose from bulk knowledge injection.

### 2.5 Context retrieval: callers, callees, slices

- **JitVul (ACL 2025).** 879 CVEs, 1,758 pairwise samples (https://arxiv.org/html/2503.03586).
  - A ReAct agent with `get_callers`, `get_callees` and `get_definition` beat plain and dependency-augmented LLMs on
    pairwise accuracy for every prompt. GPT-4o-mini pAcc was 16.81–20.17 vs 3.36–11.76 for the plain LLM (https://arxiv.org/html/2503.03586).
  - Pushing a fixed top-5 of callers and callees into the prompt sometimes hurt, which the authors attribute to noise (https://arxiv.org/html/2503.03586).
  - Higher F1 for the plain LLMs came from predicting "vulnerable" more often (https://arxiv.org/html/2503.03586).
- **LLM4FPM.** It extracts precise line-level slices with an extended code property graph that includes call edges, and
  finds the relevant files with FARF (https://arxiv.org/html/2411.03079v2).
  - On Juliet, F1 was 98.92% (FP 110, FN 22). Replacing slices with whole files gave FP 296. Dropping file-finding gave FP 569 (https://arxiv.org/html/2411.03079v2).
  - On 8 real projects it removed over 85% of false positives (https://arxiv.org/html/2411.03079v2).
- **LLMxCPG (USENIX Security 2025).** An LLM writes Joern CPGQL queries to build a minimal slice, cutting code size by
  67.84–90.93%, and a second LLM classifies the slice. The authors report 15–40% F1 gains over baselines
  (https://www.usenix.org/conference/usenixsecurity25/presentation/lekssays, https://arxiv.org/pdf/2507.16585).
  **[CAVEAT: the F1 figure comes from summaries; I read only the abstract and listing.]**
- **VulAgent.** Adding static context improved GPT-4o P-C from 17.50 to 28.73 and FPR from 38.75 to 36.34 on PrimeVul (https://arxiv.org/html/2509.11523v1).
- **SecVulEval.** Detected functions had a median of 14–33 lines and missed ones 64–71 (p < 0.05) (https://arxiv.org/html/2505.19828v1).
- **CASTLE.** LLMs do well on small snippets, but accuracy falls and hallucinations rise as code grows (https://arxiv.org/abs/2503.09433).
- **MalPR-Bench (PRGuard).** CodeRabbit identified 0/7 targets that needed evidence outside the touched files (Fisher p = 0.002).
  Unrestricted agent search was not enough on its own: 4 of 6 runs blocked without naming the target.
  The authors conclude that choosing the relevant evidence matters more than maximizing context volume (https://arxiv.org/html/2608.25730).

**Take-away:**
- Let the agent pull context on demand, which our grep/read lenses already do.
- Steer it to the specific source→sink chain rather than dumping neighbours.
- Keep each finding's evidence small and precise.

### 2.6 Multi-agent, debate and validator designs

- **GPTLens (TPS-ISA 2023).** Several "auditor" samples generate up to m candidates each. One low-temperature "harsh
  critic" scores each on correctness, severity and profitability, and the top-k are kept (https://arxiv.org/pdf/2310.01152).
  - On 13 CVE-listed smart contracts, top-1 contract-level hits rose from 38.5% to 76.9% (https://arxiv.org/pdf/2310.01152).
  - **[CAVEAT: tiny sample, workshop-scale study.]**
- **VulTrial (ICSE 2026, mock court).** Prosecutor, defense, judge and jury roles. More discussion rounds did not help (https://arxiv.org/pdf/2505.10961).
  - **[CAVEAT]** v1 and v2 report different GPT-4o gains (https://arxiv.org/pdf/2505.10961).
  - A later paper criticizes open-ended debate for lacking a definition of "vulnerable" (https://arxiv.org/html/2604.19012).
- **VulAgent (Findings of ACL 2026).** This design is closest to a lens-plus-validator setup (https://arxiv.org/html/2509.11523v1).
  - Pipeline:
    1. Specialist detectors (memory, auth flow, crypto config, injection…).
    2. Hypothesis construction: assumptions plus a trigger path from an attacker-controlled source to the sink.
    3. Each assumption is checked against Joern CFG/DFG/call-graph context and labeled valid, plausible or contradicted.
    4. A final check asks whether guards, early returns or sanitization dominate every feasible route to the sink.
  - Results (GPT-4o, PrimeVul): P-C 26.6 vs 18.6 for VulTrial, FPR 36.7 vs 52.6 (https://arxiv.org/html/2509.11523v1).
  - Ablation (SVEN): the validation chain cut FPR from 49.40% (direct evaluation) and 39.76% (VulTrial-style reflection)
    to 20.48%, with accuracy about the same (https://arxiv.org/html/2509.11523v1).
- **MAVUL (TPS-ISA 2025).** Analyst plus architect feedback loop. It claims over 62% higher pairwise accuracy than other
  multi-agent systems, but its absolute P-C is 17.5% (https://arxiv.org/pdf/2510.00317, https://github.com/youpengl/MAVUL).
- **Phoenix, "Security Is Relative" (2026).**
  - It writes an explicit Given-When-Then security contract, then judges code against it. P-C was 64.4% on PrimeVul
    paired vs 19.9% without the contract (https://arxiv.org/html/2604.19012).
  - **[CAVEAT]** The contract is generated from the vulnerable and patched pair, which leaks the label. Do not treat
    64.4% as achievable in deployment (https://arxiv.org/html/2604.19012).
  - The useful idea is "does the code satisfy this stated invariant?" rather than "is the code vulnerable?".
- **PRGuard (MalPR-Bench, 2026).** It separates candidate construction from an evidence-validation pass that marks each
  candidate Validated, Downgraded or Rejected (https://arxiv.org/html/2608.25730).
  - The verdict policy is deterministic: any Validated finding gives BLOCK, Downgraded-only gives COMMENT, otherwise APPROVE.
  - The synthesis stage cannot add findings or change the verdict.
  - False-block rate on 50 benign controls was 8–10% (https://arxiv.org/html/2608.25730).
  - This architecture closely matches ours.
- **MultiVer (2026).** Union voting across security and correctness agents reached 82.7% recall at 85.0% FPR on PyVul.
  Weighted voting gave 37.7% TPR at 35.3% FPR (https://arxiv.org/html/2602.17875v1). Union ensembles buy recall with precision.
- **SecVulEval's 5-agent pipeline.** Normalization, planning, context, detection and validation still reached only 23.83%
  statement-level F1 with Claude 3.7 Sonnet (https://arxiv.org/html/2505.19828v1).

**Take-away:**
- Validators work when they are structured: enumerate the assumptions, check each against code, then check guard dominance on every path.
- Free-form debate does not reliably help.
- Keep the verdict a deterministic function of validated findings.

### 2.7 SAST false-positive triage with LLMs (relevant if we add a SAST pre-pass)

- **LLM4PFA (path feasibility).** It filters 72–96% of false positives and misses 3 of 45 true bugs (https://arxiv.org/abs/2506.10322).
- **Tencent industrial study.**
  - LLM4PFA eliminated 94–98% of false positives with true-bug recall of 0.75–0.88 (https://arxiv.org/html/2601.18844v1).
  - Prompt-only methods eliminated 26–52% (basic) and up to 72% (few-shot Claude) (https://arxiv.org/html/2601.18844v1).
  - Cost per alarm was $0.0011–$0.12 and 2.1–109.5 s, against 10–20 min of manual review (https://arxiv.org/html/2601.18844v1).
  - Failures clustered in long functions, cascaded conditions and unusual pointer syntax (https://arxiv.org/html/2601.18844v1).
- **LLM4FPM.** Precise slicing beats whole-file context (see §2.5). About 4.7 s per warning with Qwen2.5-32B (https://arxiv.org/html/2411.03079v2).
- **ZeroFalse.** See §2.3 (https://arxiv.org/html/2510.02534v1).
- **QASecClaw (2026).** Semgrep plus an LLM filter agent on OWASP Benchmark v1.2 (https://arxiv.org/abs/2605.01885):
  - F1 rose from 78.39% to 90.93%.
  - False positives fell from 560 to 64 (−88.6%).
  - Recall fell by 3.1%.
- **IRIS contextual filtering.** See §2.2 (https://arxiv.org/html/2405.17238v3).
- **DeepVulGuard IDE study (Microsoft, ICSE 2025).** 17 professional developers on their own projects found the tool not
  yet practical because of false positives and non-applicable fixes. An LLM filtering step improved precision by over
  20% (https://arxiv.org/pdf/2412.14306).

### 2.8 Commit-, patch- and PR-level detection (closest to our setting)

- **SecPRBench, "Can Agentic Code Review Catch Vulnerabilities Before They Are Merged?" (UIUC, 2026-10-30, v2).**
  This is the most relevant study (https://arxiv.org/html/2610.33509).
  - Dataset: 265 real vulnerability-introducing commits from curl, FFmpeg, Firefox, FreeType, OpenSSL, Redis, SQLite, V8
    and Wasmtime (C, C++, Rust). Each is paired with its fixed companion and validated by PoC replay (https://arxiv.org/html/2610.33509).
  - Setting: agents get the repo snapshot, the diff and the commit message, with read/search/shell tools but no history,
    advisories or web (https://arxiv.org/html/2610.33509).
  - Recall: the best agents reached 74–78% (Grok 4.6 78.1%, GPT-6 sol 76.2%, Claude Opus 5.5 74.0% at $0.44 and 1.4
    min/task). An oracle union of all agents reached 91.3% (https://arxiv.org/html/2610.33509).
  - Misses: 68% were misdiagnoses, where the agent flagged the right file with the wrong mechanism (https://arxiv.org/html/2610.33509).
  - Recall fell from 69.6% with one root-cause file to 38.5% with five or more (https://arxiv.org/html/2610.33509).
  - Logic errors had roughly half the recall of memory-safety flaws (https://arxiv.org/html/2610.33509).
  - Security harnesses:
    - OpenAI's Codex Security cut recall by 8.3 points, mostly by abstaining (https://arxiv.org/html/2610.33509).
    - Anthropic's "Defending Code" harness raised Opus recall from 73.8% to 81.5% at about 10× the median cost
      ($3.65 vs $0.35) and with 8.4 vs 2.5 findings per scan (https://arxiv.org/html/2610.33509).
  - The credited finding was ranked first in 59.2% of multi-finding detections (https://arxiv.org/html/2610.33509).
  - **[CAVEAT]** Precision is not measured. The judge (Opus 5.5) is also an evaluated model. Fixed companions still
    drew nonempty reports 54–97% of the time (https://arxiv.org/html/2610.33509).
- **VulnSage, "Reasoning with LLMs for Zero-Shot Vulnerability Detection" (2025).** 593 vulnerabilities across 52 CWEs
  (https://arxiv.org/pdf/2503.17885).
  - A two-phase "Think & Verify" prompt (initial analysis, then confirmation with a confidence score) cut ambiguous
    answers from 20.3% to 9.1% and raised accuracy (https://arxiv.org/pdf/2503.17885).
  - Multi-function and multi-file context helps. Patch verification is harder (https://arxiv.org/pdf/2503.17885).
  - **[CAVEAT: abstract-level numbers only.]**
- **LLM security code review (Yu et al.).** 534 files from OpenStack Nova/Neutron and Qt with real review-found
  security defects, 7 LLMs, 5 prompts (https://arxiv.org/html/2401.16310v5).
  - The best configuration, DeepSeek-R1 with a CoT guardrail prompt, reached only a 9.61% "instrumental" score and a
    31.25% "misleading" score (https://arxiv.org/html/2401.16310v5).
  - Static tools scored IH-Scores at or below 1.16% (https://arxiv.org/html/2401.16310v5).
  - GPT-4 had conciseness problems in 90.18% of responses (https://arxiv.org/html/2401.16310v5).
  - LLMs do better on files with fewer tokens and with security-relevant annotations (https://arxiv.org/abs/2401.16310v5).
- **SecureReviewer (ICSE 2026).** 4,674 security-related review comments mined from the CodeReviewer dataset into 7
  categories (https://arxiv.org/html/2510.26457v1).
  - Fine-tuned 7B models reached about 72% F1 on security issue type vs 61.46% for the best baseline (https://arxiv.org/html/2510.26457v1).
  - It is a comment-generation and classification task, not a ground-truth-vulnerability task.

### 2.9 Adversarial PR authors (threats to the reviewer itself)

- **SEVRA-Bench (2026).** Real CVE fixes are inverted and wrapped in 15 social-engineering PR framings: 2,250 PRs in
  total, with a challenge split of 1,062 (https://arxiv.org/html/2606.13757).
  - The most effective framings were "Prior Approval Signal", "Dependency Compatibility Claim" and "Fake Bug Fix" (https://arxiv.org/html/2606.13757).
  - It reports a sharp gap between closed and open models (https://arxiv.org/abs/2606.13757v1).
  - Defenses were not evaluated (https://arxiv.org/html/2606.13757).
- **PRWeaver (2026).** 208 execution-validated attacks split across 2–8 PRs (https://arxiv.org/html/2608.02693v1).
  - Per-PR detection was 42–79%. Fusing the attack into a coherent carrier PR cut detection by 10–18 points (https://arxiv.org/html/2608.02693v1).
  - Whole-window review over 24 PRs fell to 16–22% (https://arxiv.org/html/2608.02693v1).
  - Claude Sonnet 4.6 in Claude Code still missed 34% of interleaved attacks (https://arxiv.org/html/2608.02693v1).

**Take-away:**
- The validator should treat PR titles and descriptions as untrusted claims, never as evidence of safety.
- Scan mode should look at cumulative state, not only per-PR diffs.

---

## 3. Known failure modes and measured mitigations

| Failure mode | Evidence | Measured mitigation |
|---|---|---|
| Flagging sanitized or patched code (bias toward "vulnerable") | GPT-4 two-shot flags both pair members in 71.63% of PrimeVul pairs (https://arxiv.org/html/2403.18624v2). Basic GPT-4o labels 77% of code vulnerable (https://arxiv.org/html/2406.11147v3). JitVul agents "over-analyze the patched guards" (https://arxiv.org/html/2503.03586). MultiVer FPR 85% from flagging patched code that still holds dangerous operations (https://arxiv.org/html/2602.17875v1). | Guard-dominance check on every path: FPR 49.4% → 20.5% (https://arxiv.org/html/2509.11523v1). Cause-without-fix rule: pair accuracy +0.16 to +0.24 (https://arxiv.org/html/2406.11147v3). An explicit contract or invariant helps; Phoenix numbers are leaky (https://arxiv.org/html/2604.19012). |
| Missing sanitizer or check recognition | Misread bounds/NULL checks cause 50% of localization errors (https://arxiv.org/html/2403.17218v2). SecVulEval: models ignore explicit null checks and over-report CWE-476/416/190 (https://arxiv.org/html/2505.19828v1). | Domain annotations cut bounds/NULL-check errors 15–70%, but 23–67% are still missed (https://arxiv.org/html/2403.17218v2). Sanitizer enumeration in a CWE-DF prompt found sanitizers in 16/20 previously missed cases (https://arxiv.org/html/2311.16169v3). |
| Name and library bias (both directions) | Safe `strcat` flagged and unsafe `strncat` passed. Unsafe use of `realpath`/`escape` judged safe (https://arxiv.org/html/2312.12575v3). Renaming flips 17–26% of answers (https://arxiv.org/abs/2312.12575). | No direct mitigation was measured. Implication: the validator must verify that a sanitizer is applied to the same value on the same path and fits the sink's context. A name alone is not evidence. |
| Over-reporting with generic prompts | Basic prompts name the wrong CWE in over 60% (Java) and over 53% (C/C++) of samples (https://arxiv.org/html/2311.16169v3). High recall with low precision for Claude and GPT-4.1 (https://arxiv.org/html/2505.19828v1). Agent harnesses file 8.4 findings per scan, and 54–97% of fixed companions still draw reports (https://arxiv.org/html/2610.33509). | CWE micro-rubrics plus traces: F1 0.52–0.69 → 0.88–0.96 (https://arxiv.org/html/2510.02534v1). Structured validation (above). |
| Inter-procedural and multi-file reasoning | Recall 69.6% with one root-cause file vs 38.5% with five or more (https://arxiv.org/html/2610.33509). LLMs mainly succeed on intra-procedural bugs (https://arxiv.org/abs/2311.16169). 0/7 outside-file targets identified by CodeRabbit (https://arxiv.org/html/2608.25730). | On-demand caller/callee tools give the best pairwise accuracy (https://arxiv.org/html/2503.03586). Precise slices beat whole files: FP 110 vs 296 (https://arxiv.org/html/2411.03079v2). |
| Right verdict, wrong reason | CodeRabbit blocked 24/31 but identified 16/31. 6 of 10 production blocks did not name the defect (https://arxiv.org/html/2608.25730). 68% of SecPRBench misses are misdiagnoses (https://arxiv.org/html/2610.33509). | Score identification and evidence separately from the verdict (https://arxiv.org/html/2608.25730). |
| Non-determinism | Inconsistent answers even at temperature 0 (https://arxiv.org/html/2312.12575v3). Highest entropy for GPT-4 (https://arxiv.org/html/2401.16310v5). | Multiple samples plus a critic (GPTLens, https://arxiv.org/pdf/2310.01152). The ensemble oracle reaches 91.3% vs 78.1% for the best single agent (https://arxiv.org/html/2610.33509). |
| Long code | Detected functions are 14–33 lines vs 64–71 for missed ones (https://arxiv.org/html/2505.19828v1). Hallucinations rise with code size (https://arxiv.org/abs/2503.09433). | Slicing (https://arxiv.org/pdf/2507.16585, https://arxiv.org/html/2411.03079v2). |
| Social engineering through PR text | See §2.9 (https://arxiv.org/html/2606.13757, https://arxiv.org/html/2608.02693v1). | None evaluated. |

---

## 4. Benchmarks

### 4.1 Realistic for diff-based PR review

| Benchmark | What it is | Fit for us | Availability |
|---|---|---|---|
| **SecPRBench** | 265 PoC-validated vulnerability-introducing commits with fixed companions, 9 C/C/Rust projects. Agent gets repo, diff and commit message (https://arxiv.org/html/2610.33509). | **Best fit**: same task shape and tool access as our reviewer. Published numbers for Claude/GPT/Grok agents and the Anthropic and OpenAI security harnesses (https://arxiv.org/html/2610.33509). Weaknesses: systems code only, no precision measure. | Code and data at github.com/secprbench/secprbench (https://arxiv.org/html/2610.33509). Benchmark license not stated. **[UNVERIFIED]** |
| **MalPR-Bench** | 89 malicious PRs and 50 benign controls, 44 repos, 8 language families, frozen rubrics scoring verdict, identification and evidence (https://arxiv.org/html/2608.25730). | **Strong fit**: has benign controls, so it measures precision, and its metric separates right reason from right verdict. Includes web and app languages. | "Shared artifact" mentioned. URL and license not found. **[UNVERIFIED]** |
| **SEVRA-Bench** | 2,250 inverted CVE-fix PRs (1,062 challenge split) across the top-10 CWEs of the 2025 Top 25, with social-engineering framings (https://arxiv.org/html/2606.13757). | Robustness of the reviewer and validator to misleading PR text. | HF RedAI4Code/SEVRA, GitHub rufimelo99/malicious-pr-bench. License not stated (https://arxiv.org/html/2606.13757). |
| **PRWeaver** | 208 attacks × 4 renderings across multiple PRs (https://arxiv.org/html/2608.02693v1). | Scan mode and cumulative-review evaluation. | Artifact mentioned, no URL found. **[UNVERIFIED]** |
| **JitVul** | 879 CVEs, 1,758 pairwise samples, functions linked to their introducing and fixing commits, from PrimeVul (https://arxiv.org/html/2503.03586). | Pairwise function-plus-repo evaluation with agent tooling. Good for validator FP testing (fixed version). | ACL 2025 (https://aclanthology.org/2025.acl-long.1490). License not checked. |
| **VICBench** | 100 verified vulnerability-inducing commits, 48 CWEs, Python/Java/C++ (https://arxiv.org/abs/2608.12246). | Built for SZZ-style VIC identification, but the commits could be replayed as PRs. VICs average 252.5 lines (https://arxiv.org/abs/2608.12246). | License not stated. **[UNVERIFIED]** |
| **SecureReviewer data** | 4,674 security-tagged review comments from CodeReviewer (https://arxiv.org/html/2510.26457v1). | Comment-quality and category signal only. Labels are human comments, not confirmed vulnerabilities. | github.com/SIMIAO515/SecureReviewer, license unstated (https://arxiv.org/html/2510.26457v1). |
| **Yu et al. security code review set** | 534 files with review-found defects, OpenStack and Qt (https://arxiv.org/html/2401.16310v5). | Real review-found defects in Python and C++. File-level, not diff-level. | Availability not checked. |

### 4.2 Repo-scale and execution-backed (useful for scan mode, less so for diffs)

- **CyberGym.** 1,507 vulnerabilities across 188 projects. The task is PoC reproduction, and the best agents reach about
  20% (https://arxiv.org/abs/2506.02548). Code is Apache-2.0. The dataset is on HF `sunblaze-ucb/cybergym` (~240 GB),
  and task IDs reference ARVO and OSS-Fuzz (https://github.com/sunblaze-ucb/cybergym). It requires execution, which our
  reviewer cannot do, but its vulnerability set could serve as scan targets.
- **SEC-bench.** 200 verified C/C++ CVEs, 29 projects, with sanitizer oracles. Best results: PoC 18.0%, patching 34.0%
  (https://arxiv.org/html/2506.11791). Dataset on HF `SEC-bench/SEC-bench`, license unstated (https://arxiv.org/html/2506.11791).
- **ARVO (EuroS&P 2026).** Over 6,100 reproducible OSS-Fuzz vulnerabilities across 311 projects, with located patches at
  89.4% accuracy (https://arxiv.org/abs/2408.02153). Memory-safety heavy.
- **CVE-Bench.** 40 critical web-app CVEs with an exploitation sandbox. Agents exploit up to 10% (zero-day) and 13%
  (one-day) (https://arxiv.org/html/2503.17332v4). An offensive benchmark, so a poor fit for a reviewer.
- **Vul4J.** 79 reproducible Java vulnerabilities, 51 projects, 25 CWEs, with PoV tests
  (https://conf.researchr.org/details/msr-2022/msr-2022-data-showcase/10/Vul4J-A-Dataset-of-Reproducible-Java-Vulnerabilities-Geared-Towards-the-Study-of-Pro).
  Vul4J+ v2.0 has 106 (https://zenodo.org/records/13752193). The fix commits can be inverted into PRs, as SEVRA does with CVE fixes.
- **CWE-Bench-Java (IRIS).** 120 manually validated Java vulnerabilities in real projects (https://arxiv.org/abs/2405.17238). Web-relevant CWEs.

### 4.3 Function-level classification sets (use for lens unit tests only; not representative of PR review)

- **PrimeVul.**
  - Size: 6,968 vulnerable and 228,800 benign functions, 140 CWEs, 5,480 pairs (https://arxiv.org/html/2403.18624v2).
  - Labels: 86–92% accurate, 0% train/test duplication (https://arxiv.org/html/2403.18624v2).
  - MIT license, distributed via Google Drive (https://github.com/DLVulDet/PrimeVul).
  - Use its paired split and the VD-S metric (FNR at FPR ≤ 0.5%) (https://arxiv.org/html/2403.18624v2).
- **BigVul.** 3,754 vulnerabilities, 91 types, 348 projects (https://2020.msrconf.org/details/msr-2020-Data-showcase/18/A-C-C-Code-Vulnerability-Dataset-with-Code-Changes-and-CVE-Summaries).
  Label accuracy is only 25% and test/train duplication 12.7% (https://arxiv.org/html/2403.18624v2). **Avoid for headline numbers.**
- **SecVulEval.** 25,440 C/C++ functions, 5,867 CVEs, statement-level labels with context (https://arxiv.org/html/2505.19828v1).
  On HF `arag0rn/SecVulEval`, with a "friendly license" that is not named (https://arxiv.org/html/2505.19828v1).
- **CASTLE.** 250 C micro-benchmarks covering 25 CWEs, scored with the CASTLE Score where false positives subtract points.
  MIT license (https://github.com/CASTLE-Benchmark/CASTLE-Benchmark, https://arxiv.org/abs/2503.09433).
- **OWASP Benchmark v1.2.** 2,740 Java test cases in 11 CWE categories, scored by Youden index (TPR − FPR), GPL-2.0
  (https://arxiv.org/abs/2605.01885, https://owasp.org/www-project-benchmark/, https://github.com/OWASP-Benchmark/BenchmarkJava).
  Synthetic: CodeQL scores F1 0.72 on it (https://arxiv.org/html/2311.16169v3), and ZeroFalse warns that benchmark
  artifacts inflate results, with Gemini at 0.910 on OWASP vs 0.372 on real alerts (https://arxiv.org/html/2510.02534v1).
- **Juliet C/C++ 1.3 (NIST SARD).** 64,099 test cases, 118 CWEs, public domain / CC0 (https://samate.nist.gov/SARD/test-suites/112).
  Synthetic. LLM4FPM gets about 99% F1 there but only 85% FP removal on real projects (https://arxiv.org/html/2411.03079v2).
- **SVEN / PairVul / VulnSage / SecLLMHolmes.** Smaller paired or curated sets used in §2
  (https://arxiv.org/html/2509.11523v1, https://arxiv.org/html/2406.11147v3, https://arxiv.org/pdf/2503.17885, https://arxiv.org/abs/2312.12575).

---

## 5. Design implications

1. **Lens decomposition.** Make one lens per OWASP:2025 family, each carrying a per-CWE micro-rubric of 10–20 rules
   (ZeroFalse-style, https://arxiv.org/html/2510.02534v1).

   Each lens must emit structured hypotheses:
   - source (attacker-controlled?);
   - propagation path (file:line chain);
   - sink;
   - sanitizers or guards on the path, and why each is insufficient;
   - the assumptions the claim depends on.

   This is the CWE-DF and VulAgent shape (https://arxiv.org/html/2311.16169v3, https://arxiv.org/html/2509.11523v1).

   Suggested lenses:
   - access control/authz, covering CWE-862/863/639/284/306 and API1/3/5;
   - injection (CWE-79/89/78/77/94/918);
   - path and file handling (CWE-22/434);
   - deserialization and integrity (CWE-502, A08);
   - crypto and secrets (A04);
   - exceptional conditions and fail-open (A10);
   - supply chain and config (A02/A03);
   - memory safety for C/C++/unsafe Rust (CWE-787/125/416/476/120–122);
   - LLM/agent code (LLM01/05/06, ASI01–05).

   Specialist routing like VulAgent's MetaAgent avoids running every lens on every diff (https://arxiv.org/html/2509.11523v1).
2. **Validator regime.** Validate per hypothesis, in this order:
   1. Re-derive the attacker-controlled source from code. PR text is untrusted
      (https://arxiv.org/html/2606.13757).
   2. Label each assumption valid, plausible or contradicted from code reads (https://arxiv.org/html/2509.11523v1).
   3. Check guard and sanitizer dominance on every path to the sink, and check that the sanitizer fits the sink context.
      Names are not evidence (https://arxiv.org/html/2509.11523v1, https://arxiv.org/html/2312.12575v3).
   4. Run a "cause present and fix absent" check against known fix patterns (https://arxiv.org/html/2406.11147v3).
   5. If the validator rejects, it states which endpoint is wrong, as IRIS does (https://arxiv.org/html/2405.17238v3).
   6. Map Validated / Downgraded / Rejected to post / soft-comment / drop deterministically (https://arxiv.org/html/2608.25730).

   Use the strongest model for validation. Weak models got worse with contextual filtering (https://arxiv.org/html/2405.17238v3).
3. **Sensitivity.** Recall headroom comes from diversity:
   - multiple samples or models with union then validation (https://arxiv.org/html/2610.33509, https://arxiv.org/pdf/2310.01152);
   - an extra pass that hunts for absence-type defects (missing checks), which are the dominant miss class
     (https://arxiv.org/html/2608.25730, https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html).

   Union without validation pushes FPR to around 85% (https://arxiv.org/html/2602.17875v1).
4. **Evaluation metrics.**
   - Pairwise or companion metrics (buggy vs fixed): P-C and VD-S (https://arxiv.org/html/2403.18624v2).
   - Attributable detection, scored as verdict ∧ identification ∧ evidence (https://arxiv.org/html/2608.25730).
   - Hit@1 / first-finding rank (https://arxiv.org/html/2610.33509).
   - Findings per clean PR as the false-positive budget.
   - Never F1 alone (https://arxiv.org/html/2503.03586).

---

## 6. Could not verify / caveats

- OWASP Top 10:2025 final release date. Secondary sources say January 2026 (https://parasoft.com/blog/owasp-top-10/).
- The OWASP LLM Top 10 **2026** item list (two consistent secondary sources), the OWASP **Agentic Top 10** ASI names
  (secondary sources), and the T1–T15 threat names. I did not read any of the OWASP PDFs.
- The LLMxCPG F1 gain range came from summaries, not the full paper.
- VulnSage numbers are abstract-level only.
- MAVUL and VulTrial gains are self-reported, and VulTrial's versions disagree.
- GPTLens rests on 13 contracts.
- Phoenix's 64.4% P-C uses specifications derived from the labeled pair, so the label leaks.
- ZeroFalse's abstract over-claims relative to its tables, and it does not isolate the CWE-rubric effect.
- LLM4FPM reports 82% vs 86% D2A accuracy in different places, and costs Qwen runs at GPT-4 prices.
- SecPRBench: no precision measure. The judge is also an evaluated model. Model names (Opus 5.5, GPT-6 sol, etc.) are as
  the paper reports them.
- Licenses unconfirmed: SecPRBench, MalPR-Bench (URL not found), PRWeaver (URL not found), SEVRA, VICBench, SEC-bench,
  CyberGym dataset, SecVulEval ("friendly", unnamed), JitVul.
- The Risse & Böhme full-text numbers were not retrieved; the USENIX page returned 521.
- SEVRA per-model approval rates live only in figures I could not read.
