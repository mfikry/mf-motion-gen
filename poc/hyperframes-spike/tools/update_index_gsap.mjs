import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.resolve(__dirname, "..", "index.html");

let content = fs.readFileSync(indexPath, "utf-8");

// 1. Replace status text in header
content = content.replace(
  `<span id="statusText">KERNEL SECURE // NOMINAL</span>`,
  `<span id="statusTextNormal">KERNEL SECURE // NOMINAL</span>
          <span id="statusTextAlert" style="position: absolute; left: 34px; opacity: 0; color: var(--red-breach);">ANOMALY DETECTED // LEVEL-4</span>
          <span id="statusTextLock" style="position: absolute; left: 34px; opacity: 0; color: var(--cyan-core);">PROTOCOL OMEGA // ISOLATED</span>`
);

// 2. Replace timerSub with 3 distinct stacked subtext elements
content = content.replace(
  `<div id="timerSub" class="timer-status-text">LOCK STATUS: PASS</div>`,
  `<div style="position: relative; height: 18px; width: 100%; display: flex; justify-content: center;">
                <span id="timerSubPass" class="timer-status-text" style="position: absolute;">LOCK STATUS: PASS</span>
                <span id="timerSubAlert" class="timer-status-text" style="position: absolute; opacity: 0; color: var(--red-breach);">ALERT: INTRUSION ACTIVE</span>
                <span id="timerSubSeal" class="timer-status-text" style="position: absolute; opacity: 0; color: var(--cyan-core);">SEAL SECURED</span>
              </div>`
);

// 3. Replace alert box inner content with 2 reversible layered views
content = content.replace(
  `<div class="alert-content">
                <div>
                  <div id="alertTag" class="alert-tag">MONITOR STATUS</div>
                  <div id="alertHeading" class="alert-heading">NETWORK STABLE</div>
                  <div id="alertDesc" class="alert-desc">FIREWALL INTEGRITY AT 100% — ALL PACKETS VERIFIED</div>
                </div>
                <div id="alertAction" class="alert-action-badge">PORT 443 OK</div>
              </div>`,
  `<div id="alertNormalView" class="alert-content">
                <div>
                  <div class="alert-tag">MONITOR STATUS</div>
                  <div class="alert-heading">NETWORK STABLE</div>
                  <div class="alert-desc">FIREWALL INTEGRITY AT 100% — ALL PACKETS VERIFIED</div>
                </div>
                <div class="alert-action-badge">PORT 443 OK</div>
              </div>
              <div id="alertBreachView" class="alert-content" style="position: absolute; inset: 24px 28px; opacity: 0;">
                <div>
                  <div class="alert-tag" style="background: var(--red-breach); color: #fff;">CRITICAL ALERT</div>
                  <div class="alert-heading" style="color: #fff;">SYSTEM BREACH ATTEMPT</div>
                  <div class="alert-desc" style="color: #cbd5e1;">UNAUTHORIZED PACKET BURST AT GATEWAY NODE 0x9F41</div>
                </div>
                <div class="alert-action-badge" style="background: rgba(255, 42, 95, 0.35); border-color: var(--red-breach); color: #ff6b8b;">ENGAGING DEFENSE</div>
              </div>`
);

// 4. Update JavaScript to remove tl.call and use pure GSAP reversible tweens
const oldPhase3and4 = content.substring(content.indexOf("// 4.5s - 6.5s: Phase 3"));
const newPhase3and4 = `// 4.5s - 6.5s: Phase 3 — Anomaly Alert & Controlled Glitch Trigger
      // -------------------------------------------------------------
      const alertNormalView = document.getElementById("alertNormalView");
      const alertBreachView = document.getElementById("alertBreachView");
      const statusTextNormal = document.getElementById("statusTextNormal");
      const statusTextAlert = document.getElementById("statusTextAlert");
      const statusTextLock = document.getElementById("statusTextLock");
      const timerSubPass = document.getElementById("timerSubPass");
      const timerSubAlert = document.getElementById("timerSubAlert");
      const timerSubSeal = document.getElementById("timerSubSeal");

      // Pure reversible property tweens for status change at 4.5s
      tl.to(statusDot, { backgroundColor: "#ff2a5f", boxShadow: "0 0 15px #ff2a5f", duration: 0.1 }, 4.5);
      tl.to(statusBadge, { borderColor: "#ff2a5f", backgroundColor: "rgba(255, 42, 95, 0.15)", duration: 0.1 }, 4.5);
      tl.to(statusTextNormal, { opacity: 0, duration: 0.1 }, 4.5);
      tl.to(statusTextAlert, { opacity: 1, duration: 0.1 }, 4.5);

      tl.to(alertNormalView, { opacity: 0, duration: 0.1 }, 4.5);
      tl.to(alertBreachView, { opacity: 1, duration: 0.1 }, 4.5);
      tl.to(timerSubPass, { opacity: 0, duration: 0.1 }, 4.5);
      tl.to(timerSubAlert, { opacity: 1, duration: 0.1 }, 4.5);
      tl.to(gaugeMeter, { stroke: "#ff2a5f", duration: 0.1 }, 4.5);

      // Flash ambient background to red
      tl.to(ambientBreach, { opacity: 0.45, duration: 0.3, ease: "power2.out" }, 4.5);

      // Controlled Glitch Slices (Deterministic keyframe offsets)
      const glitchKeyframes = [
        { time: 4.55, x: -8, y: 2, filter: "hue-rotate(90deg) contrast(150%)" },
        { time: 4.65, x: 10, y: -3, filter: "hue-rotate(240deg) contrast(180%)" },
        { time: 4.75, x: -5, y: 0, filter: "none" },
        { time: 5.10, x: 12, y: 4, filter: "invert(20%) hue-rotate(180deg)" },
        { time: 5.22, x: -10, y: -2, filter: "none" },
        { time: 5.60, x: 6, y: 1, filter: "contrast(200%)" },
        { time: 5.75, x: 0, y: 0, filter: "none" }
      ];

      glitchKeyframes.forEach((kf) => {
        tl.to(
          glitchWrapper,
          { x: kf.x, y: kf.y, filter: kf.filter, duration: 0.05, ease: "steps(1)" },
          kf.time
        );
      });

      // Gauge meter alert pulse
      tl.to(
        gaugeMeter,
        { strokeWidth: 18, duration: 0.25, yoyo: true, repeat: 3, ease: "sine.inOut" },
        4.6
      );

      // Timer countdown continuing under alert: 3.50 down to 1.50
      tl.to(
        timerObj,
        {
          time: 1.5,
          duration: 2.0,
          ease: "linear",
          onUpdate: () => {
            timerNumber.textContent = \`\${timerObj.time.toFixed(2)}s\`;
          }
        },
        4.5
      );

      // Progress bar continuing under alert: 75% to 92%
      tl.to(
        progObj,
        {
          pct: 92,
          rate: 880.2,
          frames: 220,
          duration: 2.0,
          ease: "power2.out",
          onUpdate: () => {
            progressFill.style.width = \`\${progObj.pct.toFixed(1)}%\`;
            progressValText.textContent = \`\${Math.round(progObj.pct)}%\`;
            rateMetric.textContent = \`RATE: \${progObj.rate.toFixed(1)} MB/S\`;
            framesMetric.textContent = \`SYNC: \${Math.round(progObj.frames)} / 240 FRAMES\`;
          }
        },
        4.5
      );

      // Spectrum spikes during breach
      specBars.forEach((bar, idx) => {
        const spikeHeight = 60 + ((idx * 27) % 40);
        tl.to(
          bar,
          {
            height: \`\${spikeHeight}%\`,
            background: "linear-gradient(to top, rgba(255, 42, 95, 0.3), var(--red-breach))",
            duration: 0.4,
            ease: "power2.out"
          },
          4.55 + (idx * 0.03)
        );
      });

      // -------------------------------------------------------------
      // 6.5s - 8.0s: Phase 4 — Lockdown Resolution & Seal
      // -------------------------------------------------------------
      // Pure reversible tweens for phase 4 transition
      tl.to(statusDot, { backgroundColor: "#00f0ff", boxShadow: "0 0 20px #00f0ff", duration: 0.2 }, 6.5);
      tl.to(statusBadge, { borderColor: "#00f0ff", backgroundColor: "rgba(0, 240, 255, 0.2)", duration: 0.2 }, 6.5);
      tl.to(statusTextAlert, { opacity: 0, duration: 0.1 }, 6.5);
      tl.to(statusTextLock, { opacity: 1, duration: 0.1 }, 6.5);

      tl.to(alertBreachView, { opacity: 0, duration: 0.2 }, 6.5);
      tl.to(timerSubAlert, { opacity: 0, duration: 0.2 }, 6.5);
      tl.to(timerSubSeal, { opacity: 1, duration: 0.2 }, 6.5);
      tl.to(gaugeMeter, { stroke: "#00f0ff", duration: 0.2 }, 6.5);

      // Ambient cools down
      tl.to(ambientBreach, { opacity: 0, duration: 0.6, ease: "power2.out" }, 6.5);
      tl.to(ambientCyan, { opacity: 0.5, duration: 0.6, ease: "power2.out" }, 6.5);

      // Timer hits 00.00
      tl.to(
        timerObj,
        {
          time: 0.0,
          duration: 1.5,
          ease: "power2.out",
          onUpdate: () => {
            timerNumber.textContent = \`\${timerObj.time.toFixed(2)}s\`;
          }
        },
        6.5
      );

      // Progress bar reaches 100%
      tl.to(
        progObj,
        {
          pct: 100,
          rate: 1024.0,
          frames: 240,
          duration: 1.5,
          ease: "power2.out",
          onUpdate: () => {
            progressFill.style.width = "100%";
            progressValText.textContent = "100%";
            rateMetric.textContent = "RATE: 1024.0 MB/S";
            framesMetric.textContent = "SYNC: 240 / 240 FRAMES";
          }
        },
        6.5
      );

      // Circular gauge completes 100% fill
      tl.to(
        gaugeObj,
        {
          val: 1,
          duration: 1.5,
          ease: "power2.out",
          onUpdate: () => {
            gaugeMeter.style.strokeDashoffset = "0";
          }
        },
        6.5
      );

      // Final Lockdown Stamp Stamp-In
      tl.fromTo(
        lockdownStamp,
        { opacity: 0, scale: 1.6, filter: "blur(12px)" },
        { opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.45, ease: "back.out(2)" },
        6.6
      );

      tl.to(
        lockdownStamp,
        {
          boxShadow: "0 0 60px rgba(0, 240, 255, 0.9)",
          duration: 0.8,
          yoyo: true,
          repeat: 1,
          ease: "sine.inOut"
        },
        7.05
      );

      // Ensure seek to 0 initially
      tl.seek(0);
    </script>
  </body>
</html>
`;

content = content.replace(oldPhase3and4, newPhase3and4);
fs.writeFileSync(indexPath, content, "utf-8");
console.log("Successfully updated index.html with 100% reversible GSAP tweens!");
