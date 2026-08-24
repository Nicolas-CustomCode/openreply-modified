import { redirect } from "next/navigation";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";
import LoginForm from "@/components/login-form";
import { auth } from "@/lib/auth";
import { safeCallbackUrl } from "@/lib/safe-redirect";

export const metadata = {
  title: "Login - OpenReply",
  description: "Sign in to manage Instagram comment-to-DM campaigns.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    callbackUrl?: string;
    template?: string;
  }>;
}) {
  const params = await searchParams;
  const selectedTemplate = getCampaignTemplate(params.template);
  const templateCallbackUrl = selectedTemplate
    ? `/campaigns/new?template=${selectedTemplate.slug}`
    : null;
  const callbackUrl =
    safeCallbackUrl(params.callbackUrl) ?? templateCallbackUrl ?? "/dashboard";

  // Deliberately here rather than in proxy.ts: only auth() can tell a live
  // session from a cookie that merely exists. Doing this on cookie presence
  // alone is what produced an infinite redirect against the dashboard layout.
  const session = await auth();
  if (session?.user?.id) {
    redirect(callbackUrl);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-background text-foreground">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground">
            OpenReply
          </h1>
          <p className="text-muted text-sm leading-relaxed mt-2">
            {selectedTemplate
              ? `Acesse sua conta para usar o template ${selectedTemplate.title}.`
              : "Entre com seu e-mail e senha para gerenciar suas automações."}
          </p>
        </div>

        <LoginForm
          callbackUrl={callbackUrl}
          selectedTemplateTitle={selectedTemplate?.title}
        />
      </div>
    </div>
  );
}
