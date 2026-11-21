---
title: Department administrators
description: What a department administrator can manage for the sites in their department.
audience: [department-owner]
type: written
draft: true
---

Departments split an organization into a tree (departments nested inside other departments), such as a college with its own schools. Each department has its own members and roles.

Department roles are admin, developer, billing and viewer. A department role applies to the department and to the sites inside it.

## What a department admin can do

- Rename their department.
- Add and remove department members, and change their department role. A person must already be in the organization.
- Add sites to their department and move a site into it.

## Access reviews

A department admin can decide the [access review](/docs/institutions/access-reviews) items inside their own department and the departments below it, and sees only those items. Owners and admins can turn this off with a setting on the Access Reviews page. When it is off, decisions already made stay and a department admin cannot make new ones.

## What stays with organization owners and admins

- Creating and deleting departments, and moving a department in the tree.
- Setting a Site Limit on a department. The limit counts live sites in the department and every department below it.
- Taking a site out of every department.

A department admin cannot give a role with more permissions than their own.

Policy groups can apply to a department and to the sites in it. See [Policy groups](/docs/institutions/policy-groups).

The Departments page is at `/org/departments`. Controls show only when your role allows them, and the server checks every request.
