import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";
import { ToastProvider } from "@/components/Toast";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { ContextMenuProvider } from "@/components/ContextMenu";
import { TodoProvider } from "@/hooks/useTodos";

export default function Home() {
  return (
    <Suspense>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <ContextMenuProvider>
              <TodoProvider>
                <AppShell />
              </TodoProvider>
            </ContextMenuProvider>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </Suspense>
  );
}
