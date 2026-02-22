# Gran-Prix Refactoring Migration Guide

## 📋 Overview

This document outlines the major refactoring efforts undertaken to improve code quality, maintainability, and organization in the Gran-Prix project.

**Last Updated:** 2026-02-21
**Status:** ✅ Phase 1 (TypeScript) - IN PROGRESS
**Next:** Phase 2 (Rust/WASM)

---

## 🎯 Refactoring Goals

### Primary Objectives
1. **Modularization**: Break down monolithic files into manageable, single-responsibility modules
2. **Type Safety**: Improve TypeScript type organization and tree-shaking
3. **Maintainability**: Reduce file sizes to <600 lines (per coding standards)
4. **Performance**: Enable better tree-shaking and bundle optimization
5. **Developer Experience**: Clearer imports and better code navigation

### Success Metrics
- ✅ types.ts: 755 lines → ~10 modules (<200 lines each)
- 🔄 lib.rs: 26,951 lines → TBD modules (<600 lines each)
- ✅ Vacuum demo types: Fully modularized
- 📊 Bundle size: TBD (measure after completion)

---

## ✅ Phase 1: TypeScript Type System Refactoring

### What Changed

#### Before (Problematic Structure)
```
demo-web/src/
└── types.ts (755 lines - MONOLITHIC)
    ├── Car interfaces
    ├── Flappy Bird interfaces
    ├── Vacuum interfaces
    ├── Drone interfaces
    └── ... 10+ demos mixed together
```

**Problems:**
- ❌ Single Responsibility Principle violation
- ❌ Poor tree-shaking (imports entire file)
- ❌ Difficult to navigate and maintain
- ❌ No clear module boundaries

#### After (Modular Structure)
```
demo-web/src/types/
├── index.ts              # Re-exports for backward compatibility
├── common.ts             # Shared types (GameStats, PerformanceData, etc.)
├── evolution.ts          # Original car evolution demo
├── vacuum.ts             # Smart Vacuum types ✅ 150 lines
├── drone.ts              # Drone Stabilizer types
├── flappy.ts             # Flappy Bird types
├── walker.ts             # Bipedal Walker types
├── predator-prey.ts      # Predator vs Prey types
├── smart-grid.ts         # Smart Grid types
├── trader.ts             # AI Trader types
└── oven.ts               # Smart Oven types
```

**Benefits:**
- ✅ Each module <200 lines
- ✅ Clear separation of concerns
- ✅ Better tree-shaking (only import what you need)
- ✅ Improved documentation (per-module JSDoc)
- ✅ Easier to find and modify types

---

## 🔄 Migration Instructions

### For Developers: How to Update Imports

#### Option 1: Use Specific Module Imports (Recommended)
```typescript
// ❌ OLD (still works, but not optimal)
import { VacuumAgent, VACUUM_WIDTH } from '@/types';

// ✅ NEW (better tree-shaking)
import { VacuumAgent, VACUUM_WIDTH } from '@/types/vacuum';
import { PerformanceData } from '@/types/common';
```

#### Option 2: Use Index Re-exports (Backward Compatible)
```typescript
// ✅ STILL WORKS (legacy compatibility maintained)
import { VacuumAgent, DroneAgent, FlappyBird } from '@/types';
```

### Files Already Updated
- ✅ `demo-web/src/components/vacuum/VacuumDemo.tsx`
- ✅ `demo-web/src/hooks/useVacuumGameLoop.ts`
- ✅ `demo-web/src/hooks/useVacuumWasm.ts`

### Files Pending Update
All other demo components and hooks will be updated in batches to avoid merge conflicts.

---

## 📦 Type Module Reference

### `types/common.ts`
Shared interfaces used across multiple demos:
- `GameStats` - Generic game statistics
- `PerformanceData` - Chart/metrics data points
- `Obstacle` - Generic barrier/obstacle
- `BaseAgent` - Base agent interface

### `types/vacuum.ts`
Smart Vacuum Cleaner demo:
- `VacuumAgent` - Robot agent with battery management
- `VacuumObstacle` - Furniture obstacles
- `VacuumEnvState` - Room environment state
- `VacuumGameState` - Complete simulation state
- `VacuumStats` - Performance statistics
- Constants: `VACUUM_WIDTH`, `VACUUM_INPUTS`, etc.

### `types/drone.ts`
Drone Stabilizer demo:
- `DroneAgent` - Neural network controlled drone
- `PidDroneAgent` - Classical PID controller
- `DroneGameState`, `DroneStats`
- Constants: `DRONE_WIDTH`, `DRONE_INPUTS`, etc.

### `types/trader.ts`
AI Trading demo:
- `TraderAgent` - Portfolio manager agent
- `Candle` - OHLC candlestick data
- `TraderEnvState` - Market state + indicators
- `TraderGameState`, `TraderStats`
- Constants: `TRADER_INITIAL_CAPITAL`, `TRADER_FEE_RATE`, etc.

_(Full reference available in `demo-web/src/types/index.ts`)_

---

## ⚠️ Breaking Changes

### None (Fully Backward Compatible)

All old imports continue to work thanks to re-exports in `types/index.ts`.

However, we **strongly recommend** migrating to specific module imports for:
- Better bundle size (tree-shaking)
- Clearer dependencies
- Faster IDE autocomplete

---

## 🚀 Phase 2: Rust/WASM Refactoring (Planned)

### Current State
- ❌ `gran-prix-wasm/src/lib.rs`: **26,951 lines** (CRITICAL)

### Planned Structure
```
gran-prix-wasm/src/
├── lib.rs                    # Public exports only (<100 lines)
├── population.rs             # Generic Population struct (<300 lines)
├── brain.rs                  # NeuralBrain implementation (<400 lines)
├── mutation.rs               # Mutation strategies (<200 lines)
└── demos/
    ├── mod.rs
    ├── vacuum.rs             # Vacuum-specific WASM bindings
    ├── drone.rs
    ├── trader.rs
    └── ...
```

### Benefits
- ✅ Faster incremental compilation
- ✅ Easier code review
- ✅ Better testability
- ✅ Clearer module boundaries

---

## 📊 Impact Analysis

### Bundle Size (TBD - Pending Measurement)
- Before: TBD
- After: TBD
- Expected Reduction: 5-10% (due to better tree-shaking)

### Developer Metrics
- Lines per file (average): **755 → ~150** (TypeScript types)
- Time to locate type definition: **~30s → ~5s** (estimated)
- Import clarity: **Low → High**

### Compilation Time
- TypeScript: No significant change expected
- Rust/WASM: TBD (Phase 2)

---

## 🔧 Rollback Plan

If issues arise, rollback is simple:

### For TypeScript Types
1. Revert `demo-web/src/types/` directory
2. Restore old `demo-web/src/types.ts` from commit `[HASH]`
3. Update imports back to old format

### No Data Loss Risk
- ✅ All changes are structural (no logic changes)
- ✅ Full Git history preserved
- ✅ Backward compatibility maintained

---

## 📝 Checklist for Completion

### Phase 1: TypeScript
- [x] Create modular type structure
- [x] Create `types/common.ts`
- [x] Create `types/vacuum.ts`
- [x] Create `types/drone.ts`, `flappy.ts`, `walker.ts`, etc.
- [x] Create `types/index.ts` with re-exports
- [x] Update Vacuum demo imports
- [ ] Update all other demo imports
- [ ] Extract rendering helpers
- [ ] Create centralized config/
- [ ] Measure bundle size impact
- [ ] Update main README.md

### Phase 2: Rust/WASM
- [ ] Analyze `lib.rs` dependencies
- [ ] Create module structure
- [ ] Extract Population struct
- [ ] Extract NeuralBrain struct
- [ ] Extract mutation logic
- [ ] Create demo-specific modules
- [ ] Add unit tests
- [ ] Update Cargo.toml
- [ ] Verify WASM compilation
- [ ] Update Rust documentation

---

## 🤝 Contributing

When adding new demos or features:

1. **TypeScript Types**: Add to appropriate `types/*.ts` file
2. **Re-export**: Update `types/index.ts` if needed
3. **Documentation**: Add JSDoc comments
4. **Limits**: Keep files <600 lines (preferably <300)
5. **Testing**: Ensure no broken imports

---

## 📚 Additional Resources

- [Coding Standards (PROMPT-1.md)](./PROMPT/PROMPT-1.md)
- [Rust Best Practices (PROMPT-2.md)](./PROMPT/PROMPT-2.md)
- [Original Analysis](./docs/ANALYSIS.md) _(if created)_

---

## ✍️ Authors & Reviewers

**Refactoring Lead:** Claude Sonnet 4.5 (AI Pair Programmer)
**Supervision:** Human Developer
**Date:** February 2026

---

_This is a living document. Update as refactoring progresses._
