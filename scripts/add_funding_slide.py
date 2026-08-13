"""Append slide 05 (invested to date + the ask) to the styled GoMechanic deck."""
import io

P = "docs/vroomie_gomechanic_deck.html"
s = io.open(P, encoding="utf-8").read()

SLIDE = """
  <!-- 5. INVESTED & ASK -->
  <section class="slide">
    <div class="rail"><span class="num">05</span><span class="eyebrow">Invested to date, and the ask</span></div>
    <h1>Built to here on &#8377;5 L and 5,000 hours.</h1>
    <p class="lede">Since August 2025 &mdash; founder plus freelancers. Live product, real users, patent in progress.</p>

    <div class="grid g4" style="margin-bottom:14px">
      <div class="stat"><span class="v">&#8377;5 L+</span><span class="k">Capital deployed</span></div>
      <div class="stat"><span class="v">5,000+</span><span class="k">Developer hours</span></div>
      <div class="stat"><span class="v">&#8377;9 L</span><span class="k">External borrowing</span></div>
      <div class="stat"><span class="v">10%</span><span class="k">Return due 10 Sep &mdash; on track</span></div>
    </div>

    <div class="grid g3" style="margin-bottom:14px">
      <div class="card">
        <span class="chip acc">Where it went</span>
        <h2>Engineering, freelancers, SEO, digital marketing</h2>
        <p>No office, no overhead. Every rupee into building the product and putting it in front of drivers.</p>
      </div>
      <div class="card">
        <span class="chip fix">Repayment</span>
        <h2>Funded personally, not deferred</h2>
        <p>Monetization has been slower than planned, so the September repayment is covered by a personal PF withdrawal rather than a default or a delay.</p>
      </div>
      <div class="card">
        <span class="chip fix">Traction &amp; IP</span>
        <h2>Live users, including Europe</h2>
        <p>Organic unpaid users beyond India. <b>Patent filed &mdash; provisional phase.</b></p>
      </div>
    </div>

    <div class="scroller">
      <table>
        <thead><tr><th>What scale requires</th><th>Indicative cost (estimate)</th><th>Why</th></tr></thead>
        <tbody>
          <tr><td>Cloud GPU</td><td><b>&#8377;1.2 &ndash; 2.0 L / month</b></td><td>Being implemented now &mdash; <b>not yet stable</b>; the binding constraint on the roadmap</td></tr>
          <tr><td>Supporting infra</td><td>&#8377;0.3 &ndash; 0.4 L / month</td><td>Storage, CDN, database, monitoring</td></tr>
          <tr><td>AI engineer &times; 1</td><td><b>&#8377;18 &ndash; 24 L / year</b></td><td>Model iteration and reference-library expansion</td></tr>
          <tr><td><b>12-month total</b></td><td><b>&asymp; &#8377;36 &ndash; 53 L</b></td><td>Indicative market estimates, not quoted contracts</td></tr>
        </tbody>
      </table>
    </div>

    <div class="note">
      <b>Why now:</b> the algorithm is measured and sound. The binding constraint is <b>data and compute, not code</b> &mdash; real fault recordings from real vehicles, and stable GPU capacity to iterate on them. A service-network partnership supplies the first at scale; this raise supplies the second.
    </div>
  </section>
"""

anchor = "\n</div>\n"
assert s.rstrip().endswith("</div>"), "unexpected deck ending"
idx = s.rstrip().rfind("</div>")
s = s[:idx] + SLIDE + "\n</div>\n"
io.open(P, "w", encoding="utf-8", newline="").write(s)
print("slide 05 appended; sections:", s.count("<section"))
