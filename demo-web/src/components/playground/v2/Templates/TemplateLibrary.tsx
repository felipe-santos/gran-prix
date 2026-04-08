/**
 * TemplateLibrary Component
 *
 * Displays available network templates with preview and filtering.
 * Users can browse, preview, and load pre-configured architectures.
 *
 * @module components/playground/v2/Templates/TemplateLibrary
 */

import React, { useState, useMemo } from 'react';
import { NetworkTemplate } from '@/types/network-builder';
import {
    NETWORK_TEMPLATES,
    getBeginnerTemplates,
    getAdvancedTemplates,
} from './templates';
import { Book, Zap, Star, TrendingUp, Filter, Search, X } from 'lucide-react';

// ─── Component Props ────────────────────────────────────────────────────────

interface TemplateLibraryProps {
    /** Callback when a template is selected */
    onTemplateSelect: (template: NetworkTemplate) => void;
    /** Callback to close the library */
    onClose?: () => void;
    /** Whether to show as modal */
    modal?: boolean;
}

// ─── Filter Options ─────────────────────────────────────────────────────────

type FilterCategory = 'all' | 'classification' | 'regression' | 'timeseries' | 'autoencoder';
type FilterDifficulty = 'all' | 'beginner' | 'advanced';

// ─── Main Component ─────────────────────────────────────────────────────────

export const TemplateLibrary: React.FC<TemplateLibraryProps> = ({
    onTemplateSelect,
    onClose,
    modal = false,
}) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [categoryFilter, setCategoryFilter] = useState<FilterCategory>('all');
    const [difficultyFilter, setDifficultyFilter] = useState<FilterDifficulty>('all');

    // Filter templates
    const filteredTemplates = useMemo(() => {
        let templates = [...NETWORK_TEMPLATES];

        // Search filter
        if (searchQuery) {
            const query = searchQuery.toLowerCase();
            templates = templates.filter(
                t =>
                    t.name.toLowerCase().includes(query) ||
                    t.description.toLowerCase().includes(query) ||
                    t.useCases?.some(uc => uc.toLowerCase().includes(query))
            );
        }

        // Category filter
        if (categoryFilter !== 'all') {
            templates = templates.filter(t => t.category === categoryFilter);
        }

        // Difficulty filter
        if (difficultyFilter === 'beginner') {
            templates = templates.filter(t => (t.difficulty ?? 5) <= 2);
        } else if (difficultyFilter === 'advanced') {
            templates = templates.filter(t => (t.difficulty ?? 1) >= 3);
        }

        return templates;
    }, [searchQuery, categoryFilter, difficultyFilter]);

    const containerClass = modal
        ? 'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4'
        : 'w-full h-full';

    const contentClass = modal
        ? 'bg-card border border-border rounded-2xl shadow-2xl max-w-5xl w-full max-h-[80vh] overflow-hidden flex flex-col'
        : 'w-full h-full bg-card/50 border border-border rounded-2xl overflow-hidden flex flex-col';

    return (
        <div className={containerClass}>
            <div className={contentClass}>
                {/* Header */}
                <div className="p-6 border-b border-border bg-card/80 backdrop-blur-sm">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                                <Book size={20} className="text-white" />
                            </div>
                            <div>
                                <h2 className="text-lg font-black uppercase tracking-wider text-foreground">
                                    Template Library
                                </h2>
                                <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
                                    {filteredTemplates.length} architecture{filteredTemplates.length !== 1 ? 's' : ''}
                                </p>
                            </div>
                        </div>
                        {onClose && (
                            <button
                                onClick={onClose}
                                className="p-2 rounded-lg hover:bg-muted/50 transition-colors"
                                aria-label="Close"
                            >
                                <X size={20} />
                            </button>
                        )}
                    </div>

                    {/* Search & Filters */}
                    <div className="flex flex-col sm:flex-row gap-3">
                        {/* Search */}
                        <div className="flex-1 relative">
                            <Search
                                size={14}
                                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                            />
                            <input
                                type="text"
                                placeholder="Search templates..."
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                className="
                                    w-full pl-9 pr-3 py-2
                                    bg-muted/30 border border-border/50
                                    rounded-lg
                                    text-sm text-foreground
                                    placeholder:text-muted-foreground/50
                                    focus:outline-none focus:border-cyan-500/50
                                    transition-colors
                                "
                            />
                        </div>

                        {/* Category Filter */}
                        <select
                            value={categoryFilter}
                            onChange={e => setCategoryFilter(e.target.value as FilterCategory)}
                            className="
                                px-3 py-2
                                bg-muted/30 border border-border/50
                                rounded-lg
                                text-sm text-foreground
                                focus:outline-none focus:border-cyan-500/50
                                transition-colors
                                cursor-pointer
                            "
                        >
                            <option value="all">All Categories</option>
                            <option value="classification">Classification</option>
                            <option value="regression">Regression</option>
                            <option value="timeseries">Time Series</option>
                            <option value="autoencoder">Autoencoder</option>
                        </select>

                        {/* Difficulty Filter */}
                        <select
                            value={difficultyFilter}
                            onChange={e => setDifficultyFilter(e.target.value as FilterDifficulty)}
                            className="
                                px-3 py-2
                                bg-muted/30 border border-border/50
                                rounded-lg
                                text-sm text-foreground
                                focus:outline-none focus:border-cyan-500/50
                                transition-colors
                                cursor-pointer
                            "
                        >
                            <option value="all">All Levels</option>
                            <option value="beginner">Beginner</option>
                            <option value="advanced">Advanced</option>
                        </select>
                    </div>
                </div>

                {/* Template Grid */}
                <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
                    {filteredTemplates.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <Filter size={48} className="text-muted-foreground/30 mb-4" />
                            <p className="text-sm text-muted-foreground">
                                No templates match your filters
                            </p>
                            <button
                                onClick={() => {
                                    setSearchQuery('');
                                    setCategoryFilter('all');
                                    setDifficultyFilter('all');
                                }}
                                className="mt-4 px-4 py-2 bg-cyan-500/10 border border-cyan-500/20 rounded-lg text-sm text-cyan-400 hover:bg-cyan-500/20 transition-colors"
                            >
                                Clear Filters
                            </button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {filteredTemplates.map(template => (
                                <TemplateCard
                                    key={template.id}
                                    template={template}
                                    onSelect={() => onTemplateSelect(template)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// ─── Template Card ──────────────────────────────────────────────────────────

interface TemplateCardProps {
    template: NetworkTemplate;
    onSelect: () => void;
}

const TemplateCard: React.FC<TemplateCardProps> = ({ template, onSelect }) => {
    const difficultyStars = template.difficulty ?? 1;
    const categoryColor = getCategoryColor(template.category);
    const difficultyLabel = getDifficultyLabel(difficultyStars);

    return (
        <div
            className="
                group relative
                bg-card border border-border
                rounded-xl overflow-hidden
                transition-all duration-200
                hover:shadow-xl hover:scale-[1.02]
                cursor-pointer
            "
            onClick={onSelect}
        >
            {/* Header with category badge */}
            <div className={`p-4 bg-gradient-to-br ${categoryColor}`}>
                <div className="flex items-start justify-between">
                    <div className="flex-1">
                        <h3 className="text-sm font-black text-white uppercase tracking-wider mb-1">
                            {template.name}
                        </h3>
                        <p className="text-[10px] text-white/80 font-mono">
                            {template.category}
                        </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                        {/* Difficulty stars */}
                        <div className="flex gap-0.5">
                            {Array.from({ length: 5 }).map((_, i) => (
                                <Star
                                    key={i}
                                    size={10}
                                    className={
                                        i < difficultyStars
                                            ? 'text-amber-400 fill-amber-400'
                                            : 'text-white/30'
                                    }
                                />
                            ))}
                        </div>
                        <span className="text-[8px] text-white/60 font-bold uppercase">
                            {difficultyLabel}
                        </span>
                    </div>
                </div>
            </div>

            {/* Body */}
            <div className="p-4 space-y-3">
                <p className="text-xs text-muted-foreground leading-relaxed">
                    {template.description}
                </p>

                {/* Stats */}
                <div className="flex items-center gap-4 text-[10px] text-muted-foreground font-mono">
                    <div className="flex items-center gap-1">
                        <Zap size={12} className="text-cyan-500" />
                        <span>{template.graph.layers.length} layers</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <TrendingUp size={12} className="text-emerald-500" />
                        <span>{template.graph.connections.length} connections</span>
                    </div>
                </div>

                {/* Use Cases */}
                {template.useCases && template.useCases.length > 0 && (
                    <div className="space-y-1">
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-bold">
                            Use Cases:
                        </p>
                        <div className="flex flex-wrap gap-1">
                            {template.useCases.slice(0, 3).map((useCase, i) => (
                                <span
                                    key={i}
                                    className="px-2 py-0.5 bg-muted/50 rounded text-[9px] text-muted-foreground"
                                >
                                    {useCase}
                                </span>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Footer - Load button */}
            <div className="p-4 pt-0">
                <button
                    className="
                        w-full py-2
                        bg-gradient-to-r from-cyan-500 to-blue-500
                        hover:from-cyan-600 hover:to-blue-600
                        text-white text-xs font-bold uppercase tracking-wider
                        rounded-lg
                        transition-all duration-200
                        shadow-md hover:shadow-lg
                    "
                >
                    Load Template
                </button>
            </div>

            {/* Hover indicator */}
            <div className="absolute inset-0 border-2 border-cyan-500 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
        </div>
    );
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getCategoryColor(category: NetworkTemplate['category']): string {
    const colors: Record<NetworkTemplate['category'], string> = {
        classification: 'from-blue-500 to-blue-600',
        regression: 'from-green-500 to-green-600',
        timeseries: 'from-purple-500 to-purple-600',
        autoencoder: 'from-pink-500 to-pink-600',
        custom: 'from-gray-500 to-gray-600',
    };
    return colors[category] || colors.custom;
}

function getDifficultyLabel(difficulty: number): string {
    if (difficulty <= 1) return 'Beginner';
    if (difficulty <= 2) return 'Easy';
    if (difficulty <= 3) return 'Intermediate';
    if (difficulty <= 4) return 'Advanced';
    return 'Expert';
}

// ─── Export ─────────────────────────────────────────────────────────────────

export default TemplateLibrary;
