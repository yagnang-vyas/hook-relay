import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export default function AttemptsChart({ data }: { data: { result: string; value: number }[] }) {
  return (
    <div className="h-56" role="img" aria-label="Bar chart of delivery attempts by result">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="result" stroke="var(--muted)" fontSize={12} />
          <YAxis allowDecimals={false} stroke="var(--muted)" fontSize={12} />
          <Tooltip
            contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
          />
          <Bar dataKey="value" fill="var(--accent)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
