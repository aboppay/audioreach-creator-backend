<!--
Copyright (c) Qualcomm Technologies, Inc. and/or its subsidiaries.
SPDX-License-Identifier: BSD-3-Clause
-->

# CQRS Documentation

This folder contains comprehensive documentation for the CQRS (Command Query Responsibility Segregation) pattern implementation in AudioReach Creator.

## 📚 Documentation Structure

### 1. [CQRS Architecture Overview](./cqrs-architecture-overview.md)
**Start here if you're new to CQRS or need a high-level understanding.**

- What is CQRS and why we use it
- Complete architecture diagrams (both command and query sides)
- Command vs Query comparison
- Decision tree: when to use commands vs queries
- Key principles and benefits
- Port-Adapter (Hexagonal) architecture explanation

### 2. [Query Guidelines](./cqrs-query-guidelines.md)
**Read this when implementing read operations (data retrieval).**

- Query definition patterns and naming conventions
- Query handler implementation
- QueryServices interface design
- Read Model design patterns (3-tier hierarchy)
- Complete examples and best practices
- Do's and Don'ts
- Implementation checklist

### 3. [Command Guidelines](./cqrs-command-guidelines.md)
**Read this when implementing write operations (data modification).**

- Command definition patterns and naming conventions
- Command handler implementation
- Repository pattern guidelines
- UnitOfWork usage and transaction management
- Domain entity guidelines
- Mapper guidelines (bidirectional)
- Complete examples and best practices
- Do's and Don'ts
- Implementation checklist

## 🚀 Quick Start Guide

### I need to retrieve data (read operation)
→ Use a **Query**
→ See [Query Guidelines](./cqrs-query-guidelines.md)

**Example:** Get all modules in a subgraph, fetch user profile, list projects

### I need to modify data (write operation)
→ Use a **Command**
→ See [Command Guidelines](./cqrs-command-guidelines.md)

**Example:** Create a module, update project settings, delete a use case

### I'm not sure which to use
→ See the decision tree in [Architecture Overview](./cqrs-architecture-overview.md)

## 📖 Reading Order

**For New Developers:**
1. Start with [Architecture Overview](./cqrs-architecture-overview.md) to understand the big picture
2. Read [Query Guidelines](./cqrs-query-guidelines.md) for read operations
3. Read [Command Guidelines](./cqrs-command-guidelines.md) for write operations

**For Experienced Developers:**
- Jump directly to [Query Guidelines](./cqrs-query-guidelines.md) or [Command Guidelines](./cqrs-command-guidelines.md) as needed
- Use [Architecture Overview](./cqrs-architecture-overview.md) as a reference

## 🔗 Related Documentation

- [Project Architecture Overview](../project-architecture-overview.md) - Overall system architecture
- [Upload File Design](../upload-file-design.md) - Example of complex command implementation
- [Modification Framework](../modification-framework/modification-framework-design.md) - Domain-specific patterns

## 📝 Document Versions

| Document | Version | Last Updated | Status |
|----------|---------|--------------|--------|
| Architecture Overview | 1.0 | 2026-03-17 | Active |
| Query Guidelines | 2.0 | 2026-03-17 | Active |
| Command Guidelines | 1.0 | 2026-03-17 | Active |

## 🤝 Contributing

When updating these documents:
1. Maintain consistency across all three documents
2. Update version numbers and revision history
3. Keep examples up-to-date with actual code
4. Test all Mermaid diagrams render correctly
5. Verify all cross-references and links work

---

**Questions or feedback?** Contact the Architecture Team.
