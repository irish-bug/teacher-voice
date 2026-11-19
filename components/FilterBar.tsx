/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { FilterState } from '../types';
import {
  Search,
  Sparkles,
  ChevronDown,
  Mic,
  LayoutGrid,
  GalleryHorizontalEnd,
  Sun,
  Moon,
} from 'lucide-react';

interface FilterBarProps {
  activeWorkspace: 'studio' | 'library';
  onWorkspaceChange: (workspace: 'studio' | 'library') => void;
  filters: FilterState;
  onFilterChange: (newFilters: FilterState) => void;
  uniqueGenders: string[];
  uniquePitches: string[];
  onOpenAiCasting: () => void;
  viewMode: 'carousel' | 'grid';
  onViewModeChange: (mode: 'carousel' | 'grid') => void;
  isDarkMode: boolean;
  toggleTheme: () => void;
}

const FilterBar: React.FC<FilterBarProps> = ({
  activeWorkspace,
  onWorkspaceChange,
  filters,
  onFilterChange,
  uniqueGenders,
  uniquePitches,
  onOpenAiCasting,
  viewMode,
  onViewModeChange,
  isDarkMode,
  toggleTheme,
}) => {
  const handleGenderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onFilterChange({ ...filters, gender: e.target.value });
  };

  const handlePitchChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onFilterChange({ ...filters, pitch: e.target.value });
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFilterChange({ ...filters, search: e.target.value });
  };

  return (
    <header className="relative z-50 w-full bg-white/85 dark:bg-zinc-900/85 backdrop-blur-xl border-b border-zinc-200 dark:border-zinc-800 transition-colors duration-300 shrink-0">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 h-16">
        <div className="flex items-center justify-between h-full gap-4">
          {/* Left: Brand Wordmark */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-8 h-8 bg-zinc-900 dark:bg-zinc-100 rounded-lg flex items-center justify-center shrink-0">
              <Mic size={16} className="text-white dark:text-zinc-900" />
            </div>
            <h1 className="hidden md:block text-base font-bold tracking-tight text-zinc-900 dark:text-white font-display whitespace-nowrap shrink-0">
              Teacher Voice Library
            </h1>
          </div>

          {/* Center: Workspace Navigation */}
          <nav
            className="flex items-center gap-1 p-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg border border-zinc-200/70 dark:border-zinc-700 shrink-0"
            aria-label="Workspace navigation"
          >
            <button
              type="button"
              onClick={() => onWorkspaceChange('studio')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeWorkspace === 'studio'
                  ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              Audio &amp; Captions Studio
            </button>
            <button
              type="button"
              onClick={() => onWorkspaceChange('library')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeWorkspace === 'library'
                  ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              Voice Library
            </button>
          </nav>

          {/* Right: Contextual Library Filters + AI Casting + Theme */}
          <div className="flex items-center gap-2 justify-end min-w-0">
            {activeWorkspace === 'library' && (
              <>
                <div className="relative hidden sm:block w-40 lg:w-48">
                  <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-zinc-400 dark:text-zinc-500">
                    <Search size={13} />
                  </div>
                  <input
                    type="text"
                    placeholder="Search voices..."
                    value={filters.search}
                    onChange={handleSearchChange}
                    className="block w-full pl-8 pr-2.5 py-1.5 bg-zinc-100 dark:bg-zinc-800 border border-transparent focus:bg-white dark:focus:bg-zinc-900 focus:border-zinc-300 dark:focus:border-zinc-700 rounded-lg text-xs text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none transition-all"
                  />
                </div>

                <div className="hidden xl:flex gap-2 shrink-0">
                  <div className="relative">
                    <select
                      value={filters.gender}
                      onChange={handleGenderChange}
                      className="appearance-none bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 py-1.5 pl-3 pr-7 rounded-lg text-xs font-medium focus:outline-none cursor-pointer"
                    >
                      <option value="All">All Genders</option>
                      {uniqueGenders.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      size={12}
                      className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400"
                    />
                  </div>

                  <div className="relative">
                    <select
                      value={filters.pitch}
                      onChange={handlePitchChange}
                      className="appearance-none bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 py-1.5 pl-3 pr-7 rounded-lg text-xs font-medium focus:outline-none cursor-pointer"
                    >
                      <option value="All">All Pitches</option>
                      {uniquePitches.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      size={12}
                      className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400"
                    />
                  </div>
                </div>

                <div className="flex bg-zinc-100 dark:bg-zinc-800 p-1 rounded-lg border border-zinc-200 dark:border-zinc-700 shrink-0">
                  <button
                    type="button"
                    onClick={() => onViewModeChange('carousel')}
                    className={`p-1 rounded-md transition-all ${
                      viewMode === 'carousel'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200'
                    }`}
                    title="Carousel View"
                  >
                    <GalleryHorizontalEnd size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onViewModeChange('grid')}
                    className={`p-1 rounded-md transition-all ${
                      viewMode === 'grid'
                        ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200'
                    }`}
                    title="Grid View"
                  >
                    <LayoutGrid size={14} />
                  </button>
                </div>
              </>
            )}

            <button
              type="button"
              onClick={onOpenAiCasting}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 dark:bg-indigo-600 hover:bg-zinc-800 dark:hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0"
            >
              <Sparkles size={13} />
              <span className="hidden sm:inline">AI Casting</span>
            </button>

            <button
              type="button"
              onClick={toggleTheme}
              className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors shrink-0"
              title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              aria-label={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
              {isDarkMode ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Filters Sub-bar for Voice Library */}
      {activeWorkspace === 'library' && (
        <div className="xl:hidden border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50">
          <div className="px-4 py-2 flex gap-2 overflow-x-auto scrollbar-hide">
            <select
              value={filters.gender}
              onChange={handleGenderChange}
              className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 py-1 px-3 rounded-md text-xs font-medium"
            >
              <option value="All">All Genders</option>
              {uniqueGenders.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <select
              value={filters.pitch}
              onChange={handlePitchChange}
              className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 py-1 px-3 rounded-md text-xs font-medium"
            >
              <option value="All">All Pitches</option>
              {uniquePitches.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </header>
  );
};

export default FilterBar;