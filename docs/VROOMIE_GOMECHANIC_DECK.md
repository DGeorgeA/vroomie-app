# Vroomie × GoMechanic

**AI predictive maintenance. Live product. Measured results. Seeking scale capital.**

---

## 1 — The gap

**GoMechanic knows the car only when it arrives.**

| Their scale | |
|---|---|
| Customers | 2 M+ |
| Cars serviced | 25 L+ |
| Touchpoints in India | 1,000+ |
| Rating | 4.0 / 1.5 L+ reviews |

**Three gaps:**

- **Service is calendar-based, not condition-based.** A bearing that fails the week after a service goes unnoticed until it's loud, expensive, or roadside.
- **Diagnosis needs the car on-site.** "Car Inspections" is newly listed — intent is there, but answering *"is anything wrong?"* costs a pickup, a bay and a technician hour.
- **Upsell suspicion is visible in their own reviews.** Customers praise *"no surprise additions"*, *"only for the job done"*. That praise names the fear.

**Net:** between services, India's largest independent service network receives **zero signal** from the vehicle.

## 2 — The product

**A diagnostic ear in every customer's pocket.** Point the phone at a running engine → verdict in ~3 seconds.

- No dongle, no OBD port, **no hardware cost**
- Runs **on the handset** — no per-diagnosis server bill; 1 M checks cost what 1,000 cost
- Mobile web — **no app-store install**
- Live now at vroomie.in

**Measured on recordings the system never saw in development:**

| Metric | Result |
|---|---|
| Reference recordings identified (5 capture conditions) | **42 / 42** |
| Wrong faults named | **0** |
| False alarms on speech / TV / music / fan / traffic / silence | **0** |
| Healthy cars falsely alarmed | 6 / 140 (4.3%) |
| Real unseen faults detected | ~2 in 3 |
| Time to identify | **~3 s** |

**Why it doesn't cry wolf:** it compares against *healthy* engines as well as faulty ones — so it can answer "nothing wrong". Earlier naive versions flagged a television as a power-steering fault. That failure shaped the architecture.

## 3 — The transformation

| | GoMechanic today | With Vroomie |
|---|---|---|
| Service trigger | Calendar, or a fault loud enough to worry | **Condition-based** — the car schedules the visit |
| App opened | When service is already needed | **Between services**, not only before one |
| Upsell problem | Recommendation comes from the party being paid | **Independent finding precedes the quote** |
| Inspection cost | Pickup + bay + technician hour | **Free pre-screen**; bay used for confirmed work |
| Demand visibility | Known at booking | **City-level fault signals** → forecastable pipeline |
| Parts planning | Historical averages | Detections hint **which parts, which depot** |

**Commercial logic:** cars that quietly develop faults between services either fail on the road or reach a competitor first. Every detection is a booking prompt at the moment of concern — and when the customer's own phone flagged it, the workshop's quote reads as confirmation, not a sales tactic.

**Data moat:** each detection confirmed against what the workshop actually found becomes new training data. GoMechanic's service volume is the asset that compounds accuracy fastest.

## 4 — Fuel-quality screening

**Adulteration and ethanol-blend mismatch are live consumer anxieties in India.** Vroomie screens for the engine sounds associated with fuel-quality problems and routes the customer to inspection.

| Indicator | Basis |
|---|---|
| **Piston / engine knock** | The best-established audible symptom — wrong octane or water-contaminated fuel disturbs combustion timing |
| **Power steering pump whine** | Distinct squeal-family acoustic signature |
| **Rocker arm / valve noise** | Valvetrain sounds accompanying poor combustion |

**What it tells the customer:** *"Possible relevant indicators detected"* — the sounds found, plus a recommendation to have the fuel system inspected. Every result carries a visible disclaimer that this is AI audio screening, not a laboratory fuel test.

**Why the restraint is the product:** it never declares fuel contaminated. A tool that cried "contaminated fuel" would be indefensible the first time a lab disagreed. This is what makes it safe for a service network to brand.

**Commercially:** fuel worry is one of the few reasons a driver checks a car that's running fine — converting diffuse anxiety into a bookable inspection. Admin-controlled; switchable network-wide without a release.

## 5 — Invested to date, and the ask

### Built since August 2025

| | |
|---|---|
| Capital deployed | **₹5 L+** |
| Developer hours | **5,000+** (founder + freelancers) |
| Spend areas | Engineering, freelancers, SEO strategy, digital marketing |
| External borrowing | **₹9 L** |

**Repayment position:** investor promised **10% return by 10 September** — **on track**. Monetization has been slower than planned, so repayment will be funded by a **personal PF withdrawal**. The founder is covering it personally rather than defaulting or delaying.

### Traction & IP

- Live product with active users — including a **small user base in Europe** (unpaid, organic)
- **Patent filed — provisional phase**

### What scale requires

Detection currently runs on-device. Scaling to continuous monitoring, faster model iteration and a growing reference library needs dedicated AI infrastructure. **Cloud GPU is being implemented now and is not yet stable** — it is the binding constraint on the roadmap.

| Requirement | Indicative cost *(estimate)* |
|---|---|
| Cloud GPU (inference + training) | ₹1.2 – 2.0 L / month |
| Supporting infra (storage, CDN, DB, monitoring) | ₹0.3 – 0.4 L / month |
| AI engineer × 1 (mid-to-senior, India) | ₹1.5 – 2.0 L / month · ₹18 – 24 L / year |
| **12-month total** | **≈ ₹36 – 53 L** |

*Costs are indicative market estimates, not quoted contracts.*

### Why now

The algorithm is measured and sound. The binding constraint is **data and compute, not code** — real fault recordings from real vehicles, and stable GPU capacity to iterate on them. A service network partnership supplies the first at scale; this raise supplies the second.

---

**Stated plainly:** nine fault families supported today; roughly 1 in 23 healthy cars may see a low-confidence alert; large-scale validation across handset models is the next milestone. Every figure above is reproducible from the automated test suites in the repository.
