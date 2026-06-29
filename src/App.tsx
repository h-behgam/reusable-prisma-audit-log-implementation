import { useMemo, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Code2,
  Database,
  FileJson,
  Lock,
  Play,
  ShieldCheck,
  Terminal,
  Zap,
} from "lucide-react";
import {
  AuditLogger,
  diffObjects,
  mapPrismaActionToAuditAction,
  redactSensitiveFields,
  type AuditAction,
  type AuditEntry,
} from "./audit-log";

// ---------------------------------------------------------------------------
// Demo UI: interactive documentation for the reusable AuditLog system.
// ---------------------------------------------------------------------------

const schemaCode = `model AuditLog {
  id Int @id @default(autoincrement())

  userId Int? @map("user_id")

  model    String
  recordId Int    @map("record_id")
  action   String // CREATE | UPDATE | DELETE | UPSERT

  oldData       Json?    @map("old_data")
  newData       Json?    @map("new_data")
  changedFields String[] @map("changed_fields")

  ipAddress     String? @map("ip_address")
  userAgent     String? @map("user_agent")
  requestPath   String? @map("request_path")
  requestMethod String? @map("request_method")

  metadata Json?
  createdAt DateTime @default(now()) @map("created_at")

  @@index([model, recordId])
  @@index([userId])
  @@index([action])
  @@index([createdAt])
  @@index([ipAddress])
  @@index([model, createdAt])
  @@map("audit_logs")
}`;

const setupCode = `import PrismaDB, { withAuditContext } from "@/lib/prisma";

// Wrap your handler so the extension knows the user and request context:
export async function PUT(request: NextRequest) {
  return withAuditContext(request, currentUser.id)(async () => {
    const updated = await PrismaDB.order.update({ ... });
    return NextResponse.json(updated);
  });
}`;

const manualCode = `import { AuditLogger } from "@/audit-log";

// For manual logging create an AuditLogger directly:
const audit = new AuditLogger(PrismaDB, {
  userId: currentUser.id,
  requestContext: getAuditRequestContext(request),
  sensitiveFields: ["password", "passwordHash", "token"], // value -> "[REDACTED]"
  omitFields: ["rawPassword"],                            // field removed entirely
});

await audit.log({
  model: "Order",
  recordId: order.id,
  action: "UPDATE",
  oldData: previousOrder,
  newData: updatedOrder,
  metadata: { reason: "Customer request" },
});`;

const routeCode = `import { NextRequest, NextResponse } from "next/server";
import PrismaDB, { withAuditContext } from "@/lib/prisma";

export async function PUT(request: NextRequest, { params }) {
  return withAuditContext(request, currentUser.id)(async () => {
    const id = Number(params.id);
    const body = await request.json();

    const updated = await PrismaDB.user.update({
      where: { id },
      data: body,
    });

    return NextResponse.json(updated);
  });
}`;

const createCode = `import PrismaDB from "@/lib/prisma";
import { AuditLogger, getAuditRequestContext } from "@/audit-log";

export async function POST(request: NextRequest) {
  const created = await PrismaDB.user.create({ data: await request.json() });

  const audit = new AuditLogger(PrismaDB, {
    userId: currentUser.id,
    requestContext: getAuditRequestContext(request),
  });

  await audit.log({
    model: "User",
    recordId: created.id,
    action: "CREATE",
    oldData: null,
    newData: created,
    metadata: { source: "api" },
  });

  return NextResponse.json(created, { status: 201 });
}`;

const tabs = [
  { id: "schema", label: "Prisma Schema", code: schemaCode },
  { id: "setup", label: "Setup", code: setupCode },
  { id: "manual", label: "Manual Log", code: manualCode },
  { id: "route", label: "Route Handler", code: routeCode },
  { id: "create", label: "After Insert", code: createCode },
];

interface DemoLog {
  id: number;
  model: string;
  recordId: number;
  action: AuditAction;
  changedFields: string[];
  redacted: boolean;
  entry: AuditEntry;
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl bg-slate-950 p-5 text-sm leading-relaxed text-slate-50 shadow-inner">
      <code>{code}</code>
    </pre>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:shadow-md">
      <div className="mb-4 inline-flex rounded-xl bg-indigo-50 p-3 text-indigo-600">
        <Icon className="h-6 w-6" />
      </div>
      <h3 className="mb-2 text-lg font-semibold text-slate-900">{title}</h3>
      <p className="text-sm leading-relaxed text-slate-600">{description}</p>
    </div>
  );
}

function Badge({ children, color = "indigo" }: { children: React.ReactNode; color?: "indigo" | "emerald" | "amber" | "rose" }) {
  const map = {
    indigo: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
    rose: "bg-rose-50 text-rose-700 ring-rose-600/20",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${map[color]}`}
    >
      {children}
    </span>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState("schema");
  const [action, setAction] = useState<AuditAction>("UPDATE");
  const [oldJson, setOldJson] = useState(
    JSON.stringify(
      {
        id: 1,
        email: "jane@example.com",
        name: "Jane",
        role: "USER",
        password: "plain-password",
        passwordHash: "super-secret-hash",
      },
      null,
      2
    )
  );
  const [newJson, setNewJson] = useState(
    JSON.stringify(
      {
        id: 1,
        email: "jane.doe@example.com",
        name: "Jane Doe",
        role: "ADMIN",
        password: "new-plain-password",
        passwordHash: "super-secret-hash",
      },
      null,
      2
    )
  );
  const [logs, setLogs] = useState<DemoLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const parsedOld = useMemo(() => {
    try {
      return JSON.parse(oldJson) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [oldJson]);

  const parsedNew = useMemo(() => {
    try {
      return JSON.parse(newJson) as Record<string, unknown>;
    } catch {
      return null;
    }
  }, [newJson]);

  const runAudit = () => {
    setError(null);
    if (!parsedOld || !parsedNew) {
      setError("Invalid JSON in one of the snapshots.");
      return;
    }

    // Use a fake Prisma client that stores the produced entry.
    let lastEntry: AuditEntry | null = null;
    const fakePrisma: { auditLog: { create: (args: { data: AuditEntry }) => Promise<void> } } = {
      auditLog: {
        create: async ({ data }) => {
          lastEntry = data;
        },
      },
    };

    const audit = new AuditLogger(fakePrisma, {
      userId: 42,
      requestContext: {
        ipAddress: "192.168.1.1",
        userAgent: "Mozilla/5.0",
        requestPath: "/api/users/1",
        requestMethod: "PUT",
      },
      sensitiveFields: ["password", "passwordHash"],
      omitFields: [],
    });

      void audit
        .log({
          model: "User",
          recordId: 1,
          action,
          oldData: parsedOld,
          newData: parsedNew,
          metadata: { source: "demo" },
        })
        .then(() => {
          if (!lastEntry) return;
          const redactedOld = redactSensitiveFields(parsedOld, ["password", "passwordHash"]) as Record<string, unknown>;
          const redactedNew = redactSensitiveFields(parsedNew, ["password", "passwordHash"]) as Record<string, unknown>;
          const diff = diffObjects(redactedOld, redactedNew);
          const entry = lastEntry;
          setLogs((prev) => [
            {
              id: Date.now(),
              model: "User",
              recordId: 1,
              action,
              changedFields: diff.changedFields,
              redacted: JSON.stringify(entry).includes("[REDACTED]"),
              entry,
            },
            ...prev,
          ]);
        });
    };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Hero */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="flex flex-col items-start gap-6 md:flex-row md:items-center md:justify-between">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
                <ShieldCheck className="h-4 w-4" />
                Reusable AuditLog for Next.js
              </div>
              <h1 className="text-4xl font-extrabold tracking-tight text-slate-950 sm:text-5xl">
                Audit everything.
                <br />
                <span className="text-indigo-600">Change nothing.</span>
              </h1>
              <p className="max-w-2xl text-lg text-slate-600">
                A model-agnostic, production-ready AuditLog system for Next.js and Prisma.
                Drop it into any project, any table, and start tracking changes with context.
              </p>
            </div>
            <div className="hidden md:block">
              <div className="flex h-28 w-28 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-600 to-violet-600 shadow-xl shadow-indigo-200">
                <Database className="h-14 w-14 text-white" />
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-12">
        {/* Features */}
        <section className="mb-16">
          <div className="mb-8 flex items-center gap-3">
            <Zap className="h-6 w-6 text-indigo-600" />
            <h2 className="text-2xl font-bold">Why this implementation?</h2>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              icon={Code2}
              title="Generic & Reusable"
              description="Works with any Prisma model. No schema changes to your business tables. The same code ships between projects."
            />
            <FeatureCard
              icon={Database}
              title="Driver Adapter Ready"
              description="Uses Prisma Client Extensions ($extends) instead of the unsupported $use middleware, so it works with @prisma/adapter-pg and friends."
            />
            <FeatureCard
              icon={Lock}
              title="PII Redaction"
              description="Configure sensitive fields once and every snapshot is automatically redacted before persistence."
            />
            <FeatureCard
              icon={FileJson}
              title="Diff Engine"
              description="Computes changedFields automatically for UPDATE and UPSERT actions, keeping snapshots small."
            />
            <FeatureCard
              icon={Terminal}
              title="Request Context"
              description="Captures IP, user agent, path, and HTTP method with helpers for Next.js Route Handlers and Server Actions."
            />
            <FeatureCard
              icon={CheckCircle2}
              title="Failure Isolation"
              description="Audit write failures are never thrown to the caller. Errors are forwarded to onError callbacks."
            />
          </div>
        </section>

        {/* Code examples */}
        <section className="mb-16">
          <div className="mb-6 flex items-center gap-3">
            <BookOpen className="h-6 w-6 text-indigo-600" />
            <h2 className="text-2xl font-bold">Usage examples</h2>
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex overflow-x-auto border-b border-slate-200 bg-slate-50">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`whitespace-nowrap px-5 py-3 text-sm font-medium transition ${
                    activeTab === tab.id
                      ? "border-b-2 border-indigo-600 text-indigo-700"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="p-6">
              <CodeBlock code={tabs.find((t) => t.id === activeTab)?.code ?? ""} />
            </div>
          </div>
        </section>

        {/* Interactive playground */}
        <section className="mb-16">
          <div className="mb-6 flex items-center gap-3">
            <Play className="h-6 w-6 text-indigo-600" />
            <h2 className="text-2xl font-bold">Interactive playground</h2>
          </div>
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="space-y-6">
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <label className="mb-2 block text-sm font-semibold text-slate-700">Action</label>
                <select
                  value={action}
                  onChange={(e) => setAction(e.target.value as AuditAction)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
                >
                  <option value="CREATE">CREATE</option>
                  <option value="UPDATE">UPDATE</option>
                  <option value="UPSERT">UPSERT</option>
                  <option value="DELETE">DELETE</option>
                </select>
                <p className="mt-2 text-xs text-slate-500">
                  Mapped from Prisma action{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5">
                    {mapPrismaActionToAuditAction(action.toLowerCase())}
                  </code>
                </p>
              </div>

              <div className="grid gap-6 md:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <label className="mb-2 block text-sm font-semibold text-slate-700">Old data</label>
                  <textarea
                    value={oldJson}
                    onChange={(e) => setOldJson(e.target.value)}
                    rows={10}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
                  />
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <label className="mb-2 block text-sm font-semibold text-slate-700">New data</label>
                  <textarea
                    value={newJson}
                    onChange={(e) => setNewJson(e.target.value)}
                    rows={10}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
                  />
                </div>
              </div>

              <button
                onClick={runAudit}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-200 transition hover:bg-indigo-700"
              >
                <Play className="h-4 w-4" />
                Generate Audit Log
              </button>

              {error && <p className="text-sm text-rose-600">{error}</p>}
            </div>

            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Generated audit logs</h3>
              {logs.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                  Click “Generate Audit Log” to see the produced entry.
                </div>
              )}
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Badge color="indigo">{log.model}</Badge>
                    <Badge
                      color={
                        log.action === "CREATE"
                          ? "emerald"
                          : log.action === "UPDATE"
                          ? "amber"
                          : log.action === "DELETE"
                          ? "rose"
                          : "indigo"
                      }
                    >
                      {log.action}
                    </Badge>
                    <span className="text-xs text-slate-500">record #{log.recordId}</span>
                    {log.redacted && <Badge color="rose">redacted</Badge>}
                  </div>
                  {log.changedFields.length > 0 && (
                    <p className="mb-2 text-xs text-slate-600">
                      Changed fields: {log.changedFields.join(", ")}
                    </p>
                  )}
                  <details className="group">
                    <summary className="cursor-pointer text-xs font-medium text-indigo-700">
                      View full entry
                    </summary>
                    <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-50">
                      {JSON.stringify(log.entry, null, 2)}
                    </pre>
                  </details>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Architecture notes */}
        <section>
          <h2 className="mb-6 text-2xl font-bold">Architecture notes</h2>
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <ul className="space-y-3 text-sm text-slate-700">
              <li className="flex gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-indigo-600" />
                The logger accepts a generic <code>PrismaLikeClient</code> so it never depends on a
                specific generated client version.
              </li>
              <li className="flex gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-indigo-600" />
                Prisma Client Extension (<code>$extends</code>) captures <code>create</code>,{" "}
                <code>update</code>, <code>upsert</code>, <code>delete</code>, and batch operations.
                A legacy <code>$use</code> middleware is still available for standard PrismaClient.
              </li>
              <li className="flex gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-indigo-600" />
                Diffing and redaction happen inside <code>buildEntry</code>, ensuring every log is
                consistent regardless of caller.
              </li>
              <li className="flex gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-indigo-600" />
                Request context is stored in Node.js AsyncLocalStorage via{" "}
                <code>withAuditContext</code>, so the extension can read it without a request-scoped
                config.
              </li>
              <li className="flex gap-3">
                <span className="mt-1 h-2 w-2 rounded-full bg-indigo-600" />
                The <code>AuditLog</code> table is heavily indexed for filtering by model, user,
                action, time range, and IP.
              </li>
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white py-8">
        <div className="mx-auto max-w-6xl px-6 text-center text-sm text-slate-500">
          Built for Next.js + Prisma. Copy the module into your project and adapt the config.
        </div>
      </footer>
    </div>
  );
}
