export default function ReportPlaceholder({ title }) {
  return (
    <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Este relatório ainda não possui regras de cálculo definidas.
      </p>
    </div>
  );
}
