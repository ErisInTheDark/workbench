import AgentThreadViewer from "../../../../components/workbench/thread-view/AgentThreadViewer";

export default async function Page({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  return <AgentThreadViewer initialThreadId={threadId} />;
}
