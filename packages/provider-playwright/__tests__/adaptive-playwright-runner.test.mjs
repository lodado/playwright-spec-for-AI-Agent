import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { EXECUTION_ACTION_PROPOSAL_VERSION, EXECUTION_AGENT_INPUT_VERSION } from "../../contracts/index.mjs";
import { openPlaywrightBrowserToolGateway, runAdaptiveWithPlaywright } from "../index.mjs";

const html = `<!doctype html>
<html>
  <head><link rel="icon" href="data:,"><style>body{height:2200px}#menu{display:none;position:absolute;top:900px}#settings{display:none}dialog{margin-top:80px}</style></head>
  <body>
    <aside id="cookie-banner"><button data-testid="cookie-close">Close cookies</button></aside>
    <button id="menu" data-testid="menu-toggle">Menu</button>
    <button id="settings" data-testid="settings">Settings</button>
    <dialog aria-label="Settings"><p>Private account details stay out of element observations.</p></dialog>
    <script>
      document.querySelector('[data-testid=cookie-close]').onclick = () => document.querySelector('#cookie-banner').remove();
      addEventListener('scroll', () => { if (scrollY > 300) document.querySelector('#menu').style.display = 'block'; });
      document.querySelector('#menu').onclick = () => { document.querySelector('#settings').style.display = 'block'; };
      document.querySelector('#settings').onclick = () => document.querySelector('dialog').showModal();
    </script>
  </body>
</html>`;

function input(url) {
  const exactClick = (id, description, testId) => ({ id, class: "REQUIRED_EXACT_ACTION", status: "PENDING", description, requiredAction: "click_observed_element", target: { testId } });
  return {
    schemaVersion: EXECUTION_AGENT_INPUT_VERSION,
    runId: "run-adaptive-chromium",
    scenarioId: "scenario-cookie-menu-settings",
    goal: { id: "goal-settings-dialog", description: "Open the settings dialog through the visible UI." },
    milestones: [
      exactClick("dismiss-cookie", "Dismiss the cookie banner.", "cookie-close"),
      { id: "scroll-to-menu", class: "REQUIRED_EXACT_ACTION", status: "PENDING", description: "Scroll until the menu is available.", requiredAction: "scroll_view", target: { testId: "menu-toggle" } },
      exactClick("open-menu", "Open the hidden menu.", "menu-toggle"),
      exactClick("open-settings", "Click the Settings entry.", "settings"),
      { id: "dialog-visible", class: "REQUIRED_SEMANTIC_MILESTONE", status: "PENDING", description: "The Settings dialog is visible.", target: { role: "dialog", accessibleName: { kind: "literal", value: "Settings" } } },
    ],
    currentMilestoneId: "dismiss-cookie",
    currentPage: { pageId: "page-1", domGeneration: 1, url },
    recentObservations: [],
    capabilityLease: {
      leaseId: "lease-adaptive-chromium",
      actions: ["observe_dom", "click_observed_element", "scroll_view"],
      allowedOrigins: [new URL(url).origin],
    },
    remainingBudget: { actions: 12, turns: 12, timeMs: 30_000, tokens: 8 },
  };
}

function proposer(tokenBudgets) {
  let sequence = 0;
  return async (agentInput) => {
    tokenBudgets.push(agentInput.remainingBudget.tokens);
    const milestone = agentInput.milestones.find((item) => item.id === agentInput.currentMilestoneId);
    const parameters = milestone.requiredAction === "scroll_view"
      ? { deltaX: 0, deltaY: 640 }
      : boundClick(agentInput, milestone.id) ?? {};
    const action = milestone.requiredAction === "scroll_view"
      ? "scroll_view"
      : parameters.elementId ? "click_observed_element" : "observe_dom";
    return {
      tokensUsed: 1,
      proposal: {
        schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION,
        proposalId: `proposal-${++sequence}`,
        runId: agentInput.runId,
        scenarioId: agentInput.scenarioId,
        milestoneId: agentInput.currentMilestoneId,
        leaseId: agentInput.capabilityLease.leaseId,
        action,
        parameters: action === "observe_dom" ? {} : parameters,
      },
    };
  };
}

function boundClick(agentInput, milestoneId) {
  for (const observation of agentInput.recentObservations) {
    const element = observation.elements.find((item) => item.milestoneIds.includes(milestoneId) && item.allowedActions.includes("click_observed_element"));
    if (element) return { observationId: observation.observationId, elementId: element.elementId };
  }
}

describe("adaptive Playwright runner", () => {
  it("completes the cookie, scroll, hidden menu, exact settings, and dialog flow in Chromium", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(request.url === "/dialog" ? html.replace("<dialog aria-label", "<dialog open aria-label") : html);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/`;
    const tokenBudgets = [];

    try {
      const execution = await runAdaptiveWithPlaywright({
        input: input(url),
        proposeAction: proposer(tokenBudgets),
        browserType: chromium,
        viewport: { width: 800, height: 600 },
        now: () => "2026-07-26T00:00:00.000Z",
      });

      expect(execution.outcome).toEqual({
        schemaVersion: "execution-agent-outcome/0.1",
        runId: "run-adaptive-chromium",
        scenarioId: "scenario-cookie-menu-settings",
        type: "COMPLETED",
        completedMilestoneIds: ["dismiss-cookie", "scroll-to-menu", "open-menu", "open-settings", "dialog-visible"],
      });
      expect(execution.bundles).toHaveLength(8);
      expect(execution.manifest.checkpoints).toHaveLength(8);
      expect(tokenBudgets).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
      expect(execution.bundles.flatMap((bundle) => bundle.artifacts).some((artifact) => artifact.type.includes("SCREENSHOT"))).toBe(false);

      const dialogInput = input(`${new URL(url).origin}/dialog`);
      dialogInput.milestones = [{ id: "unmatched", class: "REQUIRED_SEMANTIC_MILESTONE", status: "PENDING", description: "Keep observing.", target: { testId: "not-present" } }];
      dialogInput.currentMilestoneId = "unmatched";
      dialogInput.capabilityLease.actions.push("hover_observed_element", "wait_for_element_state");
      const gateway = await openPlaywrightBrowserToolGateway({ input: dialogInput, browserType: chromium });
      try {
        const agentInput = gateway.agentInput();
        const observed = await gateway.execute({
          proposal: {
            schemaVersion: EXECUTION_ACTION_PROPOSAL_VERSION,
            proposalId: "proposal-observe-safe-dialog",
            runId: agentInput.runId,
            scenarioId: agentInput.scenarioId,
            milestoneId: agentInput.currentMilestoneId,
            leaseId: agentInput.capabilityLease.leaseId,
            action: "observe_dom",
            parameters: {},
          },
          tokensUsed: 0,
        });
        const dialog = observed.observation.elements.find((element) => element.role === "dialog");
        expect(dialog).toEqual(expect.objectContaining({ accessibleName: "Settings", allowedActions: ["wait_for_element_state"] }));
        expect(dialog).not.toHaveProperty("text");
      } finally {
        await gateway.close();
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 30_000);
});
