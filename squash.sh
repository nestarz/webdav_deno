#!/bin/bash
original_branch="$1"
git checkout --orphan new_branch
git add .
git commit -m "chore: first commit"
git branch -M "$original_branch"
git push -f origin "$original_branch"
