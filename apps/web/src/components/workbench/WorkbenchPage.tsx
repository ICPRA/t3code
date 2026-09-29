import { Page, type PageProps } from "@project-workbench/ui";
import type { DesktopBridge } from "@t3tools/contracts";
import { LanguageSwitcher, useI18n } from "~/i18n/i18n";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { WorkbenchSessions } from "./WorkbenchSessions";
import { WorkbenchDispatch } from "./WorkbenchDispatch";
import { WorkbenchProgram } from "./WorkbenchProgram";
import { requestWorkbench } from "./WorkbenchTransport";
import { WorkbenchRepositorySearch } from "./WorkbenchRepositorySearch";
import { WorkbenchDeliveryGit } from "./WorkbenchDeliveryGit";

const readLocalData = async (request: Parameters<NonNullable<DesktopBridge["readWorkbench"]>>[0], signal: AbortSignal) => {
  signal.throwIfAborted();
  const result = await window.desktopBridge!.readWorkbench!(request);
  signal.throwIfAborted();
  return result;
};

export function WorkbenchPage({
  search,
  onSearchChange,
}: Pick<PageProps, "search" | "onSearchChange">) {
  const { language } = useI18n();
  return (
    <Page
      {...(typeof window !== "undefined" && window.desktopBridge?.readWorkbench ? { readData: readLocalData, readMail: readLocalData, requestOperation: requestWorkbench } : {})}
      search={search}
      onSearchChange={onSearchChange}
      language={language}
      languageControl={<LanguageSwitcher />}
      renderRepositorySearch={(query, specgraphProject, question) => <WorkbenchRepositorySearch query={query} specgraphProject={specgraphProject} question={question} />}
      renderDeliveryGit={(run, snapshot) => <WorkbenchDeliveryGit run={run} snapshot={snapshot} />}
      renderSessions={(runs, selected, project, onChanged, selectedRunId, nodeOwners) => <WorkbenchSessions runs={runs} selectedTask={selected} {...(selectedRunId ? { selectedRunId } : {})} project={project} onChanged={onChanged} {...(nodeOwners ? { nodeOwners } : {})}
        {...(typeof window !== "undefined" && window.desktopBridge?.readWorkbench ? { request: requestWorkbench } : {})} />}
      renderDispatch={(props) => <>
        <WorkbenchDispatch {...props} {...(typeof window !== "undefined" && window.desktopBridge?.readWorkbench ? { operationRequest: requestWorkbench } : {})} />
        <WorkbenchProgram {...props} {...(typeof window !== "undefined" && window.desktopBridge?.readWorkbench ? { operationRequest: requestWorkbench } : {})} />
      </>}
      renderTooltip={(label, trigger) => (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipPopup data-i18n-skip>{label}</TooltipPopup>
        </Tooltip>
      )}
    />
  );
}
