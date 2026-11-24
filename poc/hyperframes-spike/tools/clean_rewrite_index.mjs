import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.resolve(__dirname, "..", "index.html");

let content = fs.readFileSync(indexPath, "utf-8");

// Locate script block in index.html and rewrite timeline cleanly
const scriptStartIdx = content.indexOf("<script>\n      window.__timelines = window.__timelines || {};");
const scriptEndIdx = content.lastIndexOf("</script>");

const cleanScript = `<script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      window.__timelines["main"] = tl;

      // DOM Elements
      const ambientCyan = document.getElementById("ambientCyan");
      const ambientBreach = document.getElementById("ambientBreach");
      const cornerFrame = document.getElementById("cornerFrame");
      const headerHud = document.getElementById("headerHud");
      const leftCard = document.getElementById("leftCard");
      const rightCard = document.getElementById("rightCard");
      const gaugeMeter = document.getElementById("gaugeMeter");
      const gaugeReticle = document.getElementById("gaugeReticle");
      const timerNumber = document.getElementById("timerNumber");
      const statusBadge = document.getElementById("statusBadge");
      const statusDot = document.getElementById("statusDot");
      const statusTextNormal = document.getElementById("statusTextNormal");
      const statusTextAlert = document.getElementById("statusTextAlert");
      const statusTextLock = document.getElementById("statusTextLock");
      const alertNormalView = document.getElementById("alertNormalView");
      const alertBreachView = document.getElementById("alertBreachView");
      const glitchWrapper = document.getElementById("glitchWrapper");
      const progressFill = document.getElementById("progressFill");
      const progressValText = document.getElementById("progressValText");
      const rateMetric = document.getElementById("rateMetric");
      const framesMetric = document.getElementById("framesMetric");
      const lockdownStamp = document.getElementById("lockdownStamp");
      const specBars = document.querySelectorAll(".spec-bar");
      const timerSubPass = document.getElementById("timerSubPass");
      const timerSubAlert = document.getElementById("timerSubAlert");
      const timerSubSeal = document.getElementById("timerSubSeal");

      const circumference = 942.48; // 2 * PI * 150

      // Continuous Monotonic Proxies (100% deterministic & seek-reversible)
      const timerProxy = { time: 8.0 };
      const progProxy = { pct: 0, rate: 0, frames: 0 };
      const gaugeProxy = { offset: circumference };

      // 1. Single Continuous Countdown Timeline (8.00s -> 0.00s over 8s)
      tl.fromTo(timerProxy,
        { time: 8.0 },
        {
          time: 0.0,
          duration: 8.0,
          ease: "linear",
          onUpdate: () => {
            timerNumber.textContent = \`\${Math.max(0, timerProxy.time).toFixed(2)}s\`;
          }
        },
        0
      );

      // 2. Single Continuous Progress Timeline (0% -> 100% over 8s)
      tl.fromTo(progProxy,
        { pct: 0, rate: 0, frames: 0 },
        {
          pct: 100,
          rate: 1024,
          frames: 240,
          duration: 8.0,
          ease: "power1.inOut",
          onUpdate: () => {
            const p = Math.min(100, Math.max(0, progProxy.pct));
            progressFill.style.width = \`\${p.toFixed(1)}%\`;
            progressValText.textContent = \`\${Math.round(p)}%\`;
            rateMetric.textContent = \`RATE: \${progProxy.rate.toFixed(1)} MB/S\`;
            framesMetric.textContent = \`SYNC: \${Math.round(progProxy.frames)} / 240 FRAMES\`;
          }
        },
        0
      );

      // 3. Single Continuous Gauge Arc (0 -> 100% over 8s)
      tl.fromTo(gaugeProxy,
        { offset: circumference },
        {
          offset: 0,
          duration: 8.0,
          ease: "power1.inOut",
          onUpdate: () => {
            gaugeMeter.style.strokeDashoffset = gaugeProxy.offset.toFixed(2);
          }
        },
        0
      );

      // 4. Reticle continuous rotation
      tl.to(gaugeReticle, { rotation: 360, transformOrigin: "50% 50%", duration: 8.0, ease: "none" }, 0);

      // 5. Initial HUD boot transitions (0.0s - 1.0s)
      tl.fromTo([leftCard, rightCard], { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.8, ease: "power2.out" }, 0);
      tl.fromTo(headerHud, { opacity: 0, y: -20 }, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" }, 0.1);
      tl.fromTo(cornerFrame, { opacity: 0 }, { opacity: 0.8, duration: 0.8, ease: "power2.out" }, 0);

      // 6. Telemetry bars deterministic oscillation
      const barHeights = [
        [20, 65, 40, 80, 30, 90, 50, 75, 35, 85, 45, 95, 25, 70, 60, 40],
        [80, 30, 90, 45, 75, 20, 85, 40, 95, 35, 65, 25, 70, 50, 30, 80]
      ];
      specBars.forEach((bar, idx) => {
        tl.to(bar, { height: \`\${barHeights[0][idx]}%\`, duration: 2.0, yoyo: true, repeat: 3, ease: "sine.inOut" }, 0.2);
      });

      // 7. Phase 3 Anomaly at 4.5s (Pure reversible tweens)
      tl.to(statusDot, { backgroundColor: "#ff2a5f", boxShadow: "0 0 15px #ff2a5f", duration: 0.1 }, 4.5);
      tl.to(statusBadge, { borderColor: "#ff2a5f", backgroundColor: "rgba(255, 42, 95, 0.15)", duration: 0.1 }, 4.5);
      tl.to(statusTextNormal, { opacity: 0, duration: 0.1 }, 4.5);
      tl.to(statusTextAlert, { opacity: 1, duration: 0.1 }, 4.5);
      tl.to(alertNormalView, { opacity: 0, duration: 0.1 }, 4.5);
      tl.to(alertBreachView, { opacity: 1, duration: 0.1 }, 4.5);
      tl.to(timerSubPass, { opacity: 0, duration: 0.1 }, 4.5);
      tl.to(timerSubAlert, { opacity: 1, duration: 0.1 }, 4.5);
      tl.to(gaugeMeter, { stroke: "#ff2a5f", duration: 0.1 }, 4.5);
      tl.to(ambientBreach, { opacity: 0.45, duration: 0.3, ease: "power2.out" }, 4.5);

      // Controlled Glitch Slices
      const glitchKeyframes = [
        { time: 4.55, x: -8, y: 2, filter: "hue-rotate(90deg)" },
        { time: 4.65, x: 10, y: -3, filter: "hue-rotate(240deg)" },
        { time: 4.75, x: 0, y: 0, filter: "none" }
      ];
      glitchKeyframes.forEach((kf) => {
        tl.to(glitchWrapper, { x: kf.x, y: kf.y, filter: kf.filter, duration: 0.05 }, kf.time);
      });

      // 8. Phase 4 Lockdown at 6.5s (Pure reversible tweens)
      tl.to(statusDot, { backgroundColor: "#00f0ff", boxShadow: "0 0 20px #00f0ff", duration: 0.2 }, 6.5);
      tl.to(statusBadge, { borderColor: "#00f0ff", backgroundColor: "rgba(0, 240, 255, 0.2)", duration: 0.2 }, 6.5);
      tl.to(statusTextAlert, { opacity: 0, duration: 0.1 }, 6.5);
      tl.to(statusTextLock, { opacity: 1, duration: 0.1 }, 6.5);
      tl.to(alertBreachView, { opacity: 0, duration: 0.2 }, 6.5);
      tl.to(timerSubAlert, { opacity: 0, duration: 0.2 }, 6.5);
      tl.to(timerSubSeal, { opacity: 1, duration: 0.2 }, 6.5);
      tl.to(gaugeMeter, { stroke: "#00f0ff", duration: 0.2 }, 6.5);
      tl.to(ambientBreach, { opacity: 0, duration: 0.4 }, 6.5);

      // Lockdown Stamp Entrance at 6.6s
      tl.fromTo(lockdownStamp,
        { opacity: 0, scale: 1.4 },
        { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2)" },
        6.6
      );

      // Initial position
      tl.seek(0, false);
    </script>`;

const newContent = content.substring(0, scriptStartIdx) + cleanScript + "\n  </body>\n</html>";
fs.writeFileSync(indexPath, newContent, "utf-8");
console.log("Updated index.html with single continuous monotonic timeline!");
