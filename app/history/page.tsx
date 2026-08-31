import HistoryClient from './HistoryClient';

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ address?: string }>;
}) {
  const { address } = await searchParams;
  return <HistoryClient initialAddress={address ?? ''} />;
}
