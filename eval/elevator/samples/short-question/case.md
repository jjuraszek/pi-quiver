Did the name-cache fix also cover users renamed while deactivated?

Case facts: No. The name cache is the saved list that links names to accounts. The fix removes a deactivated user's saved entry at the next refresh; it does not listen for name changes. If Morgan is renamed to River while deactivated, the saved entry keeps Morgan until the next refresh removes it.
