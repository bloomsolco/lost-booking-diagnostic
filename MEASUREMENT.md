# BSC-009 §F — Measurement contract for Phase-1 validation

**Decision rule:** the Phase-1 H0 denominator is **tagged offer-page sessions from approved
acquisition paths** — never estimated social impressions.

## Funnel stages and where each is measured

| Stage | Where measured | Status after BSC-009 |
|---|---|---|
| Tagged offer-page session | GA4 on the offer/checkout page (lives on bloomsol.co / Gumroad, **not in this repo**) + UTM-tagged links on every approved acquisition asset | **Documented, not implementable from this repo** — remaining CP0/Phase-1 setup item |
| Checkout start | Gumroad product-page visit via UTM passthrough / Gumroad analytics | Documented |
| Purchase | Gumroad sales export filtered to product `yyzm9n6iAxsrLx2LbmW0AA==`; referrer + UTM columns give channel attribution | Available today, no build needed |
| Intake start | `intake_start` GA4 event — **implemented** in `index.html`, fires only if a GA4 tag is installed on the page | Implemented (event); GA4 tag ID still required |
| Generation start / success / failure | `generation_start`, `generation_success`, `generation_failure` events — **implemented** | Implemented (events) |
| Report save/download | `report_save` event on print-save or PDF download — **implemented** | Implemented (events) |

## Rules
- **Warm vs cold cohorts stay separate.** Encode cohort in `utm_campaign` (e.g. `warm-list` vs `cold-organic`). Never merge into one conversion rate.
- **No sensitive data in analytics.** Events carry no license keys, no email, no clinic free-text intake. (Enforced: event calls send no parameters beyond an HTTP status code on failure.)
- **No new paid tools.** GA4 is the existing no-cost stack standard. Anything paid requires founder approval.

## To activate (one config step each, founder/Sol level)
1. Add the GA4 tag (`G-…` measurement ID) to `index.html` `<head>` — events are already wired and no-op safely until then.
2. Add the same GA4 tag to the offer page on its own host, and use only UTM-tagged links in approved acquisition content.
3. Reconcile purchases weekly: Gumroad export ↔ GA4 sessions by UTM, logged to the Command Center test record.
