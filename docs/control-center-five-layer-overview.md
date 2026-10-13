# Five-layer command overview

The existing team-only /production/health route opens with a Five-layer overview.
It consumes the same OperationsV2 evidence as the action queue, source freshness,
delivery and onboarding views. No new query, provider call, mutation or authorization
path is introduced.

The overview classifies stable readiness and alert keys:

1. Client Intelligence: brand, services, claims, keywords and intent/owner pages.
2. Data & Intelligence: Google reporting evidence, ranking observations,
   backlink provider evidence and reporting baselines.
3. AI Engine: current Authority inventory and orphan draft requests.
4. Work Management: human article/social approvals and backlink follow-ups.
5. Execution & Measurement: website/channel destinations and unresolved delivery.

CRM Lite, billing and portal evidence are supporting systems. Unknown future keys
stay visible as Other evidence. All counts and next-action links follow the selected
client roster; foreign-client alerts are excluded. Distinct brand requirements are
counted individually rather than collapsed into their parent client's approval.

Bars show composition of recorded, missing, waiting, blocked and unknown readiness
evidence. They are not health or completion scores. The Work Management queue does
not invent a percentage. An empty queue does not prove external provider health.
Source errors retain an explicit partial-visibility warning. Recovered release alerts
are removed by the existing upstream OperationsV2 rules, not re-created here.

Next actions use existing workflow URLs, with critical alerts before attention and
setup. Where no alert exists, blocked/unknown/missing/waiting requirements provide
a review link. Viewing or following these links does not approve, publish, charge,
enable SMS or invite portal users.

Validation: operations-overview.test.mjs covers layer classification, client
isolation, multiple brands, missing/unknown data, action priority and stable
read-only calculations. The existing control-center-ui CI job also exercises
default overview, exact review links, client filtering, screenshots and mobile
width, followed by the existing source, failure and onboarding checks.
