"""Tighten the GoMechanic deck copy and add a print stylesheet (one slide per page)."""
import io

P = "docs/vroomie_gomechanic_deck.html"
s = io.open(P, encoding="utf-8").read()

REPL = [
    ("<p class=\"lede\">The network is formidable at <em>fulfilling</em> service. What it cannot yet do is know a car needs service before the customer does.</p>",
     "<p class=\"lede\">Formidable at <em>fulfilling</em> service. Cannot yet know a car needs service before the customer does.</p>"),
    ("<p>Periodic servicing runs on a calendar. A bearing that starts failing the week after a service goes unnoticed until it is loud, expensive, or roadside.</p>",
     "<p>A bearing that fails the week after a service goes unnoticed until it is loud, expensive or roadside.</p>"),
    ("<p>\"Car Inspections\" is a newly listed service — the intent is clearly there. But it still costs a pickup, a bay, and a technician's hour to answer \"is anything wrong?\"</p>",
     "<p>\"Car Inspections\" is newly listed — intent is there. But answering <em>\"is anything wrong?\"</em> still costs a pickup, a bay and a technician hour.</p>"),
    ("<p>Customers praise \"no surprise additions\" and \"only for the job done\". That praise reveals the underlying fear: that a recommendation is a sales pitch, not a finding.</p>",
     "<p>Customers praise <em>\"no surprise additions\"</em>, <em>\"only for the job done\"</em>. That praise names the fear: a recommendation may be a sales pitch, not a finding.</p>"),
    ("<b>The strategic read:</b> the app today is a booking funnel — it is opened when the customer has already decided something is needed. Between services, the world's largest independent service network has no signal from the vehicle at all.",
     "<b>Net:</b> the app is a booking funnel, opened only once the customer has already decided. Between services the network receives <b>zero signal</b> from the vehicle."),

    ("<p class=\"lede\">The customer points their phone at the running engine. Vroomie listens, and in about three seconds tells them whether it sounds healthy — and if not, what it most likely is.</p>",
     "<p class=\"lede\">Point the phone at a running engine. Verdict in ~3 seconds: healthy, or the most likely fault.</p>"),
    ("<p>Analysis happens on the device. No per-diagnosis server bill, so a million checks a month cost the same to run as a thousand.</p>",
     "<p>On-device analysis. No per-diagnosis server bill — a million checks cost what a thousand cost.</p>"),
    ("<p>Deployed as a mobile web app — no app-store install required. Every session, including failures, records why it reached its conclusion.</p>",
     "<p>Mobile web, no app-store install. Every session — including failures — records why it concluded what it did.</p>"),

    ("<p class=\"lede\">The same network, the same bays, the same technicians — reached by customers who now arrive with evidence instead of a suspicion.</p>",
     "<p class=\"lede\">Same network, same bays, same technicians — reached by customers arriving with evidence instead of suspicion.</p>"),
    ("<p>Cars that quietly develop faults between services either fail on the road or reach a competitor first. A detection is a booking prompt at the moment of concern.</p>",
     "<p>Cars developing faults between services either fail on the road or reach a competitor first. Each detection is a booking prompt at the moment of concern.</p>"),
    ("<p>When the customer's own phone flagged it first, the workshop's recommendation reads as confirmation, not as a sales tactic.</p>",
     "<p>When the customer's own phone flagged it first, the quote reads as confirmation — not a sales tactic.</p>"),
    ("<p>Detections confirmed against what the workshop actually found become new reference data. GoMechanic's service volume is the exact asset that improves accuracy fastest.</p>",
     "<p>Detections confirmed against what the workshop found become new training data. GoMechanic's volume is the asset that compounds accuracy fastest.</p>"),

    ("<p class=\"lede\">Fuel adulteration and ethanol-blend mismatch are live consumer anxieties in India. Vroomie's Ethanol Contamination Check screens for the engine sounds associated with fuel-quality problems — and routes the customer to a workshop inspection.</p>",
     "<p class=\"lede\">Adulteration and ethanol-blend mismatch are live consumer anxieties in India. Vroomie screens for the engine sounds associated with fuel-quality problems and routes the customer to inspection.</p>"),
    ("<p>The best-established audible symptom. Incorrect octane or water-contaminated fuel disturbs combustion timing, producing the characteristic knock.</p>",
     "<p>The best-established audible symptom — wrong octane or water-contaminated fuel disturbs combustion timing.</p>"),
    ("<p>A high-pitched squeal-family sound the engine detects as a distinct acoustic signature.</p>",
     "<p>Distinct squeal-family acoustic signature.</p>"),
    ("<p>Valvetrain sounds that can accompany poor combustion conditions.</p>",
     "<p>Valvetrain sounds accompanying poor combustion.</p>"),
    ("<b>For GoMechanic:</b> fuel-quality worry is one of the few reasons a driver inspects a car that is otherwise running fine. This converts a diffuse anxiety into a specific, bookable inspection — an admin-controlled feature that can be switched on network-wide without a release.",
     "<b>For GoMechanic:</b> fuel worry is one of the few reasons a driver checks a car that is running fine — converting diffuse anxiety into a bookable inspection. Admin-controlled; switchable network-wide without a release."),
]

missed = 0
for a, b in REPL:
    if a not in s:
        missed += 1
        print("MISS:", a[:70])
    s = s.replace(a, b)

PRINT_CSS = """
  @media print{
    @page{ size:A4 landscape; margin:9mm; }
    html,body{ background:#fff !important; }
    :root{
      --ground:#FFFFFF; --surface:#FFFFFF; --surface-2:#F4F4F0;
      --ink:#12161C; --ink-2:#39414D; --muted:#5F6874; --hair:#CFCFC8;
      --accent:#A2650B; --accent-soft:#F7E9CE;
      --critical:#A81E17; --critical-soft:#F8E0DE;
      --good:#1B5F3C; --good-soft:#DCEFE3;
      --shadow:none;
    }
    .deck{ gap:0; padding:0; max-width:none; }
    .slide{
      break-after:page; page-break-after:always; break-inside:avoid;
      border:none; border-radius:0; box-shadow:none; padding:11mm 13mm;
    }
    .slide:last-child{ break-after:auto; page-break-after:auto; }
    .slide::before{ width:2.5mm; }
    .cover{ padding:34mm 13mm; }
    h1{ font-size:24pt; }
    .cover h1{ font-size:32pt; }
    .lede{ font-size:10.5pt; margin-bottom:13px; }
    .stat .v{ font-size:16pt; } .stat .k{ font-size:7.8pt; }
    .card p, li, td, th{ font-size:8.4pt; }
    h2{ font-size:9.4pt; }
    .step .t{ font-size:8.4pt; } .step .d{ font-size:7.6pt; }
    .note{ font-size:8.4pt; margin-top:13px; }
    .foot{ font-size:7.2pt; }
    .chip{ font-size:7.2pt; }
    *{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }
"""
s = s.replace("</style>", PRINT_CSS + "</style>")
io.open(P, "w", encoding="utf-8", newline="").write(s)
print("misses:", missed, "| chars:", len(s), "| print css:", "@media print" in s)
