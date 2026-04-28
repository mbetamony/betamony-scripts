# Hotfix Documentation

## Steps to Create the Hotfix

1. **Fetch all tags**
    - Command: `git fetch --all --tags`
2. **Checkout the release tag**
    - Command: `git checkout tag`

3. **Create a new branch**
    - Command: `git checkout -b hotfix/<issue-id>`

4. **Implement the Fix**
    - Describe the changes made to fix the issue.
    - Include code snippets if necessary.

5. **Create a New Tag**
    - Command: `git tag <new_tag_name>`

6. **Push the new tag to the repository**
    - Command: `git push origin <new_tag_name>`

7. **Update the release on GitHub**
    - Create a new release (going to the tags page, you could create a release from there)
