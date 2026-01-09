function formatSimilarity(similarity) {
    if (similarity === null || similarity === undefined) return '—';
    const percent = Number(similarity) * 100;
    return `${percent.toFixed(1)}%`;
}

function formatCreatedAt(createdAt) {
    if (!createdAt) return '—';
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return createdAt;
    return date.toLocaleString('ru-RU');
}

export function formatMatchMessage(match) {
    const rawTextShort = match?.rawTextShort?.trim();
    const lines = [
        '🔎 Рекомендация:',
        `• Описание: ${rawTextShort || '—'}`,
        `• Тип: ${match.type ?? '—'}`,
        `• Город/страна: ${match.city ?? '—'}, ${match.country ?? '—'}`,
        `• Статус: ${match.status ?? '—'}`,
        `• Похожесть: ${formatSimilarity(match.similarity)}`,
        `• Создано: ${formatCreatedAt(match.createdAt)}`,
    ];

    return lines.join('\n');
}

export function formatRequestSummary(request) {
    const rawText = request.rawText;
    if (!rawText) {
        return '• Запрос';
    }

    const normalizedText = rawText.replace(/\s+/g, ' ').trim();
    const maxLength = 120;
    const trimmedText =
        normalizedText.length > maxLength
            ? `${normalizedText.slice(0, maxLength - 1)}…`
            : normalizedText;

    return `• ${trimmedText}`;
}
